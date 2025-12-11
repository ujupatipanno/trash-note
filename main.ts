import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, Editor, MarkdownView, TFile, TFolder, SuggestModal } from 'obsidian';

interface TrashNoteSettings {
	trashNotePath: string;
	addTimestamp: boolean;
	timestampFormat: string;
	moveDestinationPath: string;
	placeholderFormat: string;
}

const DEFAULT_SETTINGS: TrashNoteSettings = {
	trashNotePath: '',
	addTimestamp: false,
	timestampFormat: 'YYYY-MM-DD HH:mm',
	moveDestinationPath: '',
	placeholderFormat: 'YYYY-MM-DD'
}

export default class TrashNotePlugin extends Plugin {
	settings!: TrashNoteSettings;
	private appendQueue: Promise<void> = Promise.resolve();

	async onload() {
		await this.loadSettings();

		// 설정 탭 추가
		this.addSettingTab(new TrashNoteSettingTab(this.app, this));

		// 파일 rename 이벤트 감지 - trash-note 경로 자동 업데이트
		this.registerEvent(
			this.app.vault.on('rename', async (file, oldPath) => {
				if (this.settings.trashNotePath === oldPath) {
					this.settings.trashNotePath = file.path;
					await this.saveSettings();
					new Notice(`trash-note의 이름이 변경되었습니다: "${file.name}"`);
				}
			})
		);

		// 명령어 등록
		const commands: Array<[string, string, string, boolean?, string?]> = [
			['set-trash-note', '현재 문서를 trash-note로 지정', 'setTrashNote'],
			['move-selection-to-trash', 'trash-note로 옮기기', 'moveSelectionToTrash', true, 'trash'],
			['open-trash-note', 'trash-note 문서 열기', 'openTrashNote', false, 'trash-2'],
			['move-trash-to-new-note', 'trash-note 내용을 새 노트로 옮기고 비우기', 'moveTrashToNewNote'],
		];

		commands.forEach(([id, name, method, isEditor, icon]) => {
			this.addCommand({
				id,
				name,
				...(icon && { icon }),
				...(isEditor 
					? { editorCallback: (editor: Editor) => (this as any)[method](editor) }
					: { callback: () => (this as any)[method]() }
				)
			});
		});

		// 리본에 아이콘 추가
		this.addRibbonIcon('trash-2', 'trash-note 문서 열기', async () => {
			await this.openTrashNote();
		});
	}

	private async getActiveFile(): Promise<TFile | null> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) {
			new Notice('현재 파일을 찾을 수 없습니다.');
			return null;
		}
		return view.file;
	}

	private async setTrashNote() {
		const file = await this.getActiveFile();
		if (!file) return;

		this.settings.trashNotePath = file.path;
		await this.saveSettings();
		new Notice(`trash-note가 "${file.basename}"으로 지정되었습니다.`);
	}

	private async moveSelectionToTrash(editor: Editor) {
		const trashFile = await this.ensureTrashNoteFile();
		if (!trashFile) return;

		// 현재 문서가 trash-note인지 확인
		const currentFile = this.app.workspace.getActiveFile();
		if (currentFile?.path === trashFile.path) {
			new Notice('trash-note 문서에서는 이 명령을 사용할 수 없습니다.');
			return;
		}

		const selection = editor.getSelection();
		let content = selection;
		let from, to;

		// 선택된 영역이 없으면 현재 행을 선택
		if (!content) {
			const lineNumber = editor.getCursor().line;
			content = editor.getLine(lineNumber);
			from = { line: lineNumber, ch: 0 };
			to = { line: lineNumber + 1, ch: 0 };
		} else {
			// 선택된 영역의 범위 얻기
			from = editor.getCursor('from');
			to = editor.getCursor('to');
		}

		// 선택된 영역 삭제
		editor.replaceRange('', from, to);

		// trash-note에 추가
		await this.appendToTrashNote(content);
	}

	private async appendToTrashNote(content: string) {
		this.appendQueue = this.appendQueue.then(async () => {
			try {
				const trashFile = await this.ensureTrashNoteFile();
				if (!trashFile) return;

				const currentContent = await this.app.vault.read(trashFile);
				let newContent = currentContent;

				if (currentContent && !currentContent.endsWith('\n')) {
					newContent += '\n';
				}

				if (this.settings.addTimestamp) {
					const timestamp = this.getFormattedTimestamp();
					newContent += '\n' + timestamp + '\n' + content + '\n';
				} else {
					newContent += '\n' + content + '\n';
				}

				await this.app.vault.modify(trashFile, newContent);
				new Notice('trash-note로 옮겨졌습니다.');
			} catch (error) {
				console.error(error);
				new Notice('trash-note로 옮기는 중 오류가 발생했습니다.');
			}
		});

		return this.appendQueue;
	}

	getFormattedTimestamp(format?: string): string {
		const now = new Date();
		const formatMap: Record<string, string> = {
			'YYYY': now.getFullYear().toString(),
			'MM': String(now.getMonth() + 1).padStart(2, '0'),
			'DD': String(now.getDate()).padStart(2, '0'),
			'HH': String(now.getHours()).padStart(2, '0'),
			'mm': String(now.getMinutes()).padStart(2, '0'),
		};
		return (format || this.settings.timestampFormat).replace(
			/YYYY|MM|DD|HH|mm/g,
			match => formatMap[match]
		);
	}

	private async openTrashNote() {
		try {
			const trashFile = await this.ensureTrashNoteFile();
			if (!trashFile) return;

			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(trashFile);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} catch (error) {
			console.error(error);
			new Notice('trash-note를 여는 중 오류가 발생했습니다.');
		}
	}

	private async moveTrashToNewNote() {
		const trashFile = await this.ensureTrashNoteFile();
		if (!trashFile) return;

		const trashContent = await this.app.vault.read(trashFile);

		new CreateNoteModal(this.app, this, async (title: string, modal) => {
			const safeTitle = this.sanitizeTitle(title.trim() || modal.placeholderText);
			if (!safeTitle || !safeTitle.trim()) {
				modal.showError('유효한 제목이 필요합니다.');
				return false;
			}

			const destinationPath = this.settings.moveDestinationPath || '';
			const newPath = this.buildNotePath(destinationPath, safeTitle);

			try {
				if (await this.app.vault.adapter.exists(newPath)) {
					modal.showError('같은 이름의 노트가 이미 존재합니다. 다른 제목을 입력해주세요.');
					return false;
				}

				await this.app.vault.create(newPath, trashContent);
				await this.app.vault.modify(trashFile, '');
				new Notice(`"${safeTitle}" 노트가 생성되었습니다.`);
				return true;
			} catch (error) {
				console.error(error);
				modal.showError('노트를 생성하거나 trash-note를 비우는 중 오류가 발생했습니다.');
				return false;
			}
		}).open();
	}

	private sanitizeTitle(input: string): string {
		// 경로로 사용할 수 없는 문자 단순 치환
		return input.replace(/[\\/:*?"<>|]/g, '-').trim();
	}

	private buildNotePath(destinationPath: string, title: string): string {
		return destinationPath ? `${destinationPath}/${title}.md` : `${title}.md`;
	}

	private async ensureTrashNoteFile(): Promise<TFile | null> {
		try {
			let targetPath = this.settings.trashNotePath?.trim();
			if (!targetPath) {
				targetPath = 'trash.md';
			}

			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				if (!this.settings.trashNotePath) {
					this.settings.trashNotePath = existing.path;
					await this.saveSettings();
				}
				return existing;
			}

			const created = await this.app.vault.create(targetPath, '');
			this.settings.trashNotePath = created.path;
			await this.saveSettings();
			new Notice(`trash-note가 없어 기본 파일을 생성했습니다: ${created.path}`);
			return created;
		} catch (error) {
			console.error(error);
			new Notice('trash-note 기본 파일을 생성하는 중 오류가 발생했습니다.');
			return null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TrashNoteSuggestModal extends SuggestModal<TFile> {
	plugin: TrashNotePlugin;
	settingTab: TrashNoteSettingTab | null;

	constructor(app: App, plugin: TrashNotePlugin, settingTab?: TrashNoteSettingTab) {
		super(app);
		this.plugin = plugin;
		this.settingTab = settingTab || null;
		this.setPlaceholder('trash-note로 지정할 문서를 검색하세요');
	}

	getSuggestions(query: string): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		if (!query) {
			return files;
		}
		return files.filter(file =>
			file.basename.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl('div', { text: file.basename });
		el.createEl('small', { text: file.path, cls: 'obsidian-suggests-path' });
	}

	async onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.trashNotePath = file.path;
		await this.plugin.saveSettings();
		new Notice(`trash-note가 "${file.basename}"으로 지정되었습니다.`);
		
		// 설정 탭의 description 실시간 업데이트
		if (this.settingTab?.trashNoteSetting) {
			const newDesc = file.path ? `현재 지정: ${file.path}` : '현재 지정된 trash-note가 없습니다.';
			this.settingTab.trashNoteSetting.setDesc(newDesc);
		}
	}
}

class CreateNoteModal extends Modal {
	titleInput!: HTMLInputElement;
	statusEl!: HTMLDivElement;
	placeholderText: string;
	plugin: TrashNotePlugin;
	onSubmit: (title: string, modal: CreateNoteModal) => Promise<boolean | void> | boolean | void;

	constructor(app: App, plugin: TrashNotePlugin, onSubmit: (title: string, modal: CreateNoteModal) => Promise<boolean | void> | boolean | void) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.placeholderText = this.plugin.getFormattedTimestamp(this.plugin.settings.placeholderFormat || 'YYYY-MM-DD');
	}

	showError(message: string) {
		this.statusEl.setText(message);
		this.statusEl.addClass('mod-warning');
	}

	clearMessage() {
		this.statusEl.setText('');
		this.statusEl.removeClass('mod-warning');
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h3', { text: '새 노트의 제목을 입력해주세요' });

		this.titleInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: this.placeholderText
		});

		this.statusEl = contentEl.createDiv();

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		const confirmBtn = buttonContainer.createEl('button', { 
			text: '확인',
			cls: 'mod-cta'
		});
		confirmBtn.onclick = async () => {
			this.clearMessage();
			const title = this.titleInput.value.trim() || this.placeholderText;
			const shouldClose = await this.onSubmit(title, this);
			if (shouldClose !== false) {
				this.close();
			}
		};

		const cancelBtn = buttonContainer.createEl('button', { text: '취소' });
		cancelBtn.onclick = () => this.close();

		this.titleInput.focus();

		this.titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				confirmBtn.click();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class TrashNoteSettingTab extends PluginSettingTab {
	plugin: TrashNotePlugin;
	trashNoteSetting: Setting | null = null;

	constructor(app: App, plugin: TrashNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		const timestampExample = this.plugin.getFormattedTimestamp(this.plugin.settings.timestampFormat || 'YYYY-MM-DD HH:mm');

		const trashDesc = this.plugin.settings.trashNotePath ? `현재 지정: ${this.plugin.settings.trashNotePath}` : '현재 지정된 trash-note가 없습니다.';
		this.trashNoteSetting = new Setting(containerEl)
			.setName('trash-note 파일')
			.setDesc(trashDesc)
			.addButton(button => {
				button.setButtonText('검색하여 지정');
				button.onClick(() => {
					new TrashNoteSuggestModal(this.app, this.plugin, this).open();
				});
			});

		// 타임스탬프 토글
		new Setting(containerEl)
			.setName('타임스탬프 자동 추가')
			.setDesc('이동한 내용 맨 앞에 자동으로 타임스탬프를 추가합니다.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.addTimestamp);
				toggle.onChange(async (value) => {
					this.plugin.settings.addTimestamp = value;
					await this.plugin.saveSettings();
				});
			});

		// 타임스탬프 형식
		const timestampSetting = new Setting(containerEl)
			.setName('타임스탬프 형식')
			.setDesc(`기본 형식: YYYY-MM-DD HH:mm (YYYY, MM, DD, HH, mm). 현재 예시: ${timestampExample}`)
			.addText(text => {
				text.setValue(this.plugin.settings.timestampFormat);
				text.onChange(async (value) => {
					this.plugin.settings.timestampFormat = value;
					await this.plugin.saveSettings();
					// 실시간 예시 업데이트
					const newExample = this.plugin.getFormattedTimestamp(value || 'YYYY-MM-DD HH:mm');
					timestampSetting.setDesc(`기본 형식: YYYY-MM-DD HH:mm (YYYY, MM, DD, HH, mm). 현재 예시: ${newExample}`);
				});
			});

		// 새 노트 제목 placeholder 형식
		new Setting(containerEl)
			.setName('새 노트 제목 placeholder')
			.setDesc('YYYY, MM, DD, HH, mm를 사용할 수 있습니다. 비워두면 기본값(YYYY-MM-DD) 사용')
			.addText(text => {
				text.setPlaceholder('YYYY-MM-DD');
				text.setValue(this.plugin.settings.placeholderFormat);
				text.onChange(async (value) => {
					this.plugin.settings.placeholderFormat = value || 'YYYY-MM-DD';
					await this.plugin.saveSettings();
				});
			});

		// 새 노트 생성 위치
		new Setting(containerEl)
			.setName('새 노트 생성 위치')
			.setDesc('trash-note 내용을 옮길 때 새 노트를 생성할 폴더')
			.addDropdown(dropdown => {
				const folders = this.app.vault.getAllLoadedFiles()
					.filter(f => f instanceof TFolder)
					.map(f => f.path);
				
				dropdown.addOption('', 'Vault 루트');
				folders.forEach(folder => {
					dropdown.addOption(folder, folder);
				});
				
				dropdown.setValue(this.plugin.settings.moveDestinationPath);
				dropdown.onChange(async (value) => {
					this.plugin.settings.moveDestinationPath = value;
					await this.plugin.saveSettings();
				});
			});
	}
}

