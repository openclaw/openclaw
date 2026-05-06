import { MainViewModel } from '../viewmodel/MainViewModel';
import { ChatMessage, ChatPendingToolCall, ChatSessionEntry } from '../model/GatewayModels';
import { Markdown, MarkdownController } from '@luvi/lv-markdown-in';

@Component
export struct ChatPage {
  @ObjectLink viewModel: MainViewModel;
  @StorageProp('localeVersion') localeVersion: number = 0;

  @State messageText: string = '';
  @State showThinkingOptions: boolean = false;
  @State showSessionList: boolean = false;
  @State chatMessagesState: ChatMessage[] = [];
  @State chatStreamingTextState: string = '';
  @State chatPendingToolCallsState: ChatPendingToolCall[] = [];
  @State chatErrorState: string = '';
  @State chatHealthOkState: boolean = false;
  @State chatThinkingLevelState: string = 'off';
  @State chatSessionKeyState: string = '';
  @State chatSessionsState: ChatSessionEntry[] = [];
  @State pendingRunCountState: number = 0;

  private chatStateListenerId: number = -1;
  private messageScroller: Scroller = new Scroller();
  private lastScrollToken: string = '';
  private streamingMarkdownController: MarkdownController = new MarkdownController();
  private userMarkdownController: MarkdownController = new MarkdownController();
  private openclawMarkdownController: MarkdownController = new MarkdownController();

  aboutToAppear(): void {
    this.configureMarkdownControllers();

    this.syncChatState();
    this.chatStateListenerId = this.viewModel.addChatStateListener(() => {
      this.syncChatState();
    });
    this.viewModel.loadChat(this.viewModel.mainSessionKey);
    this.viewModel.refreshChatSessions(200);
    this.scheduleInitialScroll();
  }

  aboutToDisappear(): void {
    if (this.chatStateListenerId >= 0) {
      this.viewModel.removeChatStateListener(this.chatStateListenerId);
      this.chatStateListenerId = -1;
    }
  }

  build() {
    Column({ space: 8 }) {
      this.ChatHeader();

      if (this.chatErrorState.length > 0) {
        this.ChatErrorRail(this.chatErrorState);
      }

      this.MessagesList();
      this.Composer();
    }
    .width('100%')
    .height('100%')
    .padding({ left: 20, right: 20, top: 12, bottom: 12 });
  }

  @Builder ChatHeader() {
    Column({ space: 8 }) {
      Row() {
        Text($r('app.string.chat_session'))
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor('#4D5563');

        Blank();

        this.ChatConnectionPill();
      }
      .width('100%');

      Row() {
        Text(this.currentSessionLabel())
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor('#17181C')
          .layoutWeight(1)
          .maxLines(1);

        Button({ type: ButtonType.Normal }) {
          Text($r('app.string.chat_sessions'))
            .fontSize(12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#1D5DD8');
        }
        .height(34)
        .backgroundColor('#ECF3FF')
        .borderRadius(999)
        .padding({ left: 12, right: 12 })
        .onClick(() => {
          this.showSessionList = !this.showSessionList;
          this.showThinkingOptions = false;
        });
      }
      .width('100%');

      Row() {
        ForEach(this.sessionOptions(), (session: ChatSessionEntry) => {
          this.SessionChip(session);
        });
      }
      .width('100%');
    }
    .width('100%');
  }

  @Builder ChatConnectionPill() {
    Row() {
      Circle()
        .width(8)
        .height(8)
        .fill(this.chatHealthOkState ? '#2F8C5A' : '#C8841A');

      Text((this.chatHealthOkState ? $r('app.string.chat_connected') : $r('app.string.chat_offline')))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.chatHealthOkState ? '#2F8C5A' : '#C8841A')
        .margin({ left: 6 });
    }
    .padding({ left: 8, right: 8, top: 4, bottom: 4 })
    .backgroundColor(this.chatHealthOkState ? '#E8F5EC' : '#FFF4DE')
    .borderRadius(999)
    .border({ width: 1, color: this.chatHealthOkState ? '#BEE0CA' : '#F0D19A' });
  }

  private isActiveSession(session: ChatSessionEntry): boolean {
    return session.key === this.chatSessionKeyState;
  }

  @Builder SessionChip(session: ChatSessionEntry) {
    Button({ type: ButtonType.Normal }) {
      Text(this.friendlySessionName(session.displayName || session.key))
        .fontSize(12)
        .fontWeight(this.isActiveSession(session) ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(this.isActiveSession(session) ? '#FFFFFF' : '#17181C');
    }
    .height(36)
    .backgroundColor(this.isActiveSession(session) ? '#1D5DD8' : '#FFFFFF')
    .borderRadius(14)
    .border({ width: 1, color: this.isActiveSession(session) ? '#154CAD' : '#D6DAE2' })
    .padding({ left: 12, right: 12 })
    .margin({ right: 8 })
    .onClick(() => {
      this.viewModel.switchChatSession(session.key);
      this.showSessionList = false;
    });
  }

  @Builder ChatErrorRail(errorText: string) {
    Column({ space: 2 }) {
      Text($r('app.string.chat_error_title'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor('#DC2626');

      Text(errorText)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#17181C');
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor('#FFFFFF')
    .borderRadius(12)
    .border({ width: 1, color: '#DC2626' });
  }

  @Builder MessagesList() {
    Scroll(this.messageScroller) {
      Column({ space: 10 }) {
        if (this.chatMessagesState.length === 0) {
          this.EmptyState();
        } else {
          ForEach(this.chatMessagesState, (message: ChatMessage) => {
            this.MessageItem(message);
          }, (message: ChatMessage, index: number) => this.messageListKey(message, index));

          if (this.chatStreamingTextState.length > 0) {
            this.StreamingMessage(this.chatStreamingTextState);
          }

          if (this.chatPendingToolCallsState.length > 0) {
            this.PendingToolCallsRail();
          }
        }
      }
      .width('100%')
      .padding({ top: 8, bottom: 8 });
    }
    .width('100%')
    .layoutWeight(1);
  }

  @Builder EmptyState() {
    Column({ space: 8 }) {
      Text('💬')
        .fontSize(44);

      Text($r('app.string.chat_empty_title'))
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17181C');

      Text($r('app.string.chat_empty_description'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#8A92A2')
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .padding({ top: 48, bottom: 48, left: 24, right: 24 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder MessageItem(message: ChatMessage) {
    Row({ space: 3 }) {
      if (message.role !== 'user') {
        this.MessageAvatar(false);
      } else {
        Blank().width(32);
      }

      if (message.role === 'user') {
        Blank().layoutWeight(1);
      }

      Column({ space: 4 }) {
        this.MarkdownMessage(this.messageTextValue(message), message.role === 'user');
      }
      .constraintSize({ minWidth: 0, maxWidth: '80%' })
      .flexShrink(1)
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      .backgroundColor(message.role === 'user' ? '#98E866' : '#FFFFFF')
      .borderRadius(16)
      .border({ width: message.role === 'user' ? 0 : 1, color: '#E5E7EC' })
      .shadow({ radius: 8, color: '#14000000', offsetX: 0, offsetY: 2 });

      if (message.role !== 'user') {
        Blank().layoutWeight(1);
      }

      if (message.role === 'user') {
        this.MessageAvatar(true);
      } else {
        Blank().width(32);
      }
    }
    .width('100%');
  }

  @Builder StreamingMessage(text: string) {
    Row({ space: 8 }) {
      this.MessageAvatar(false);

      Column({ space: 4 }) {
        Text('OpenClaw')
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8A92A2');

        this.StreamingMarkdownContent(text);
      }
      .constraintSize({ minWidth: 0, maxWidth: '78%' })
      .flexShrink(1)
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      .backgroundColor('#FFFFFF')
      .borderRadius(16)
      .border({ width: 1, color: '#E5E7EC' })
      .shadow({ radius: 8, color: '#14000000', offsetX: 0, offsetY: 2 });

      Blank().layoutWeight(1);
    }
    .width('100%');
  }

  @Builder MessageAvatar(isUser: boolean) {
    Stack({ alignContent: Alignment.Center }) {
      Circle()
        .width(32)
        .height(32)
        .fill(isUser ? '#1D5DD8' : '#E8F5EC');

      Text((isUser ? $r('app.string.chat_user_avatar_text') : $r('app.string.chat_assistant_avatar_text')))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor(isUser ? '#FFFFFF' : '#2F8C5A');
    }
    .width(32)
    .height(32);
  }

  @Builder MarkdownMessage(text: string, isUser: boolean) {
      Markdown({
        controller: this.getMarkdownControllerForRole(isUser),
        text: this.bubbleSafeMarkdown(text)
      }).constraintSize({ minWidth: 0 })
  }

  @Builder StreamingMarkdownContent(text: string) {
    Markdown({
      controller: this.streamingMarkdownController,
      text: this.bubbleSafeMarkdown(text)
    });
  }

  @Builder PendingToolCallsRail() {
    Column({ space: 8 }) {
      Text($r('app.string.chat_tools_running'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor('#8A92A2');

      ForEach(this.chatPendingToolCallsState, (toolCall: ChatPendingToolCall) => {
        Row() {
          Column({ space: 2 }) {
            Text(toolCall.name)
              .fontSize(13)
              .fontWeight(FontWeight.Bold)
              .fontColor('#17181C');

            if ((toolCall.paramsJson || '').length > 0) {
              Text(toolCall.paramsJson)
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor('#8A92A2')
                .maxLines(3);
            }
          }
          .layoutWeight(1);

          Text('…')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#1D5DD8');
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .backgroundColor('#F6F7FA')
        .borderRadius(12)
        .border({ width: 1, color: '#E5E7EC' });
      });
    }
    .width('100%');
  }

  @Builder Composer() {
    Column({ space: 10 }) {
      Row() {
        Button({ type: ButtonType.Normal }) {
          Text(`${this.localizedThinking(this.chatThinkingLevelState)}`)
            .fontSize(12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#1D5DD8');
        }
        .height(34)
        .backgroundColor('#ECF3FF')
        .borderRadius(999)
        .padding({ left: 12, right: 12 })
        .onClick(() => {
          this.showThinkingOptions = !this.showThinkingOptions;
          this.showSessionList = false;
        });

        Blank();

        Button({ type: ButtonType.Normal }) {
          Text($r('app.string.chat_refresh'))
            .fontSize(12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#4D5563');
        }
        .height(34)
        .backgroundColor('#F6F7FA')
        .borderRadius(999)
        .padding({ left: 12, right: 12 })
        .onClick(() => {
          this.viewModel.refreshChat();
          this.viewModel.refreshChatSessions(200);
        });
      }
      .width('100%');

      if (this.showThinkingOptions) {
        this.ThinkingOptions();
      }

      if (this.showSessionList) {
        this.SessionList();
      }

      Row() {
        TextInput({ placeholder: this.chatHealthOkState ? $r('app.string.chat_input_placeholder') : $r('app.string.chat_connect_placeholder'), text: this.messageText })
          .layoutWeight(1)
          .height(48)
          .backgroundColor('#F7F8FA')
          .borderColor('#E5E7EC')
          .borderWidth(1)
          .borderRadius(22)
          .padding({ left: 16, right: 16 })
          .fontSize(14)
          .fontColor('#17181C')
          .enabled(this.chatHealthOkState && this.pendingRunCountState === 0)
          .margin({ right: 8 })
          .onChange((value: string) => {
            this.messageText = value;
          });

        Button(this.pendingRunCountState > 0 ? '■' : '➤')
          .width(48)
          .height(48)
          .backgroundColor(this.canSendMessage() || this.canAbortMessage() ? '#1D5DD8' : '#E5E7EC')
          .borderRadius(24)
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.canSendMessage() || this.canAbortMessage() ? '#FFFFFF' : '#8A92A2')
          .enabled(this.canSendMessage() || this.canAbortMessage())
          .onClick(() => {
            if (this.canAbortMessage()) {
              this.abortMessage();
            } else {
              this.sendMessage();
            }
          });
      }
      .width('100%');
    }
    .width('100%')
    .padding({ top: 8, bottom: 4 });
  }

  @Builder ThinkingOptions() {
    Column({ space: 8 }) {
      Text($r('app.string.chat_thinking_level'))
        .fontSize(14)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17181C');

      ForEach(['off', 'low', 'medium', 'high'], (level: string) => {
        Row() {
          Text(this.localizedThinkingLevel(level))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor('#17181C');

          Blank();

          if (this.chatThinkingLevelState === level) {
            Text('✓')
              .fontSize(14)
              .fontColor('#1D5DD8');
          }
        }
        .width('100%')
        .padding({ top: 8, bottom: 8 })
        .onClick(() => {
          this.viewModel.setChatThinkingLevel(level);
          this.showThinkingOptions = false;
        });
      });
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .backgroundColor('#FFFFFF')
    .borderRadius(12)
    .border({ width: 1, color: '#E5E7EC' });
  }

  @Builder SessionList() {
    Column({ space: 8 }) {
      Row() {
        Text($r('app.string.chat_sessions'))
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor('#17181C');

        Blank();

        Text($r('app.string.chat_close'))
          .fontSize(16)
          .fontColor('#8A92A2')
          .onClick(() => {
            this.showSessionList = false;
          });
      }
      .width('100%');

      ForEach(this.sessionOptions(), (session: ChatSessionEntry) => {
        Column({ space: 2 }) {
          Text(this.friendlySessionName(session.displayName || session.key))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor('#17181C');

          if (session.updatedAtMs > 0) {
            Text(this.sessionUpdatedText(session.updatedAtMs))
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .fontColor('#8A92A2');
          }
        }
        .width('100%')
        .padding({ top: 8, bottom: 8 })
        .onClick(() => {
          this.viewModel.switchChatSession(session.key);
          this.showSessionList = false;
        });
      });
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .backgroundColor('#FFFFFF')
    .borderRadius(12)
    .border({ width: 1, color: '#E5E7EC' });
  }

  private canSendMessage(): boolean {
    return this.chatHealthOkState && this.pendingRunCountState === 0 && this.messageText.trim().length > 0;
  }

  private canAbortMessage(): boolean {
    return this.pendingRunCountState > 0;
  }

  private sendMessage(): void {
    if (!this.canSendMessage()) {
      return;
    }

    const message = this.messageText.trim();
    this.messageText = '';

    this.viewModel.sendChat(message, this.chatThinkingLevelState, []);
  }

  private abortMessage(): void {
    if (!this.canAbortMessage()) {
      return;
    }
    this.viewModel.abortChat();
  }

  private currentSessionLabel(): string {
    return this.friendlySessionName(this.chatSessionKeyState);
  }

  private sessionOptions(): ChatSessionEntry[] {
    const existing: ChatSessionEntry[] = [...this.chatSessionsState];
    const hasCurrent = existing.findIndex((session: ChatSessionEntry) => session.key === this.chatSessionKeyState) >= 0;
    if (hasCurrent) {
      return existing;
    }
    const current = new ChatSessionEntry();
    current.key = this.chatSessionKeyState;
    current.displayName = this.chatSessionKeyState === this.viewModel.mainSessionKey ? 'Main' : this.chatSessionKeyState;
    current.updatedAtMs = Date.now();
    existing.unshift(current);
    return existing;
  }

  private syncChatState(): void {
    this.chatMessagesState = [...this.viewModel.chatMessages];
    this.chatStreamingTextState = this.viewModel.chatStreamingAssistantText || '';
    this.chatPendingToolCallsState = [...this.viewModel.chatPendingToolCalls];
    this.chatErrorState = this.viewModel.chatError || '';
    this.chatHealthOkState = this.viewModel.chatHealthOk;
    this.chatThinkingLevelState = this.viewModel.chatThinkingLevel || 'off';
    this.chatSessionKeyState = this.viewModel.chatSessionKey || this.viewModel.mainSessionKey;
    this.chatSessionsState = [...this.viewModel.chatSessions];
    this.pendingRunCountState = this.viewModel.pendingRunCount;
    this.scheduleScrollToBottom();
  }

  private configureMarkdownControllers(): void {
    this.configureMarkdownController(this.streamingMarkdownController, '#17181C', '#1D5DD8', '#F6F7FA', '#F6F7FA');
    this.streamingMarkdownController.setThreadRenderEnable(true);
    this.configureMarkdownController(this.userMarkdownController, '#17181C', '#0B4F22', '#D9F6B8', '#E7F8D3');
    this.configureMarkdownController(this.openclawMarkdownController, '#17181C', '#1D5DD8', '#F6F7FA', '#F6F7FA');
    this.userMarkdownController.setThreadRenderEnable(true);
    this.openclawMarkdownController.setThreadRenderEnable(true);
  }

  private configureMarkdownController(controller: MarkdownController,
    textColor: string,
    hyperlinkColor: string,
    inlineCodeBackgroundColor: string,
    quoteBackgroundColor: string): void {
    controller
      .setTextColor(textColor)
      .setTextSize(14)
      .setTextLineHeight(20)
      .setTitleColor('#17181C')
      .setTitleSize([20, 18, 17, 16, 15, 14])
      .setTitleLineHeight([28, 26, 24, 22, 21, 20])
      .setTitleFontWeight(FontWeight.Bold)
      .setInlineCodeColor('#C2410C')
      .setInlineCodeBackgroundColor(inlineCodeBackgroundColor)
      .setInlineCodeBackgroundRadius(6)
      .setQuoteBorderColor('#1D5DD8')
      .setQuoteBorderWidth(4)
      .setQuoteBorderRadius(12)
      .setQuoteBackgroundColor(quoteBackgroundColor)
      .setHyperlinkTextColor(hyperlinkColor)
      .setHyperlinkUnderlineState(true)
      .setCodeBlockBorderRadius(12)
      .setCodeBlockTheme('light')
      .setCodeBlockIdxState(false)
      .setImageBorderRadius(12)
      .setImageWidth('100%')
      .setTableAlign(FlexAlign.Start)
      .setTableBorderRadius(12)
      .setTableOuterBorderColor('#D6DAE2');
  }

  private getMarkdownControllerForRole(isUser: boolean): MarkdownController {
    return isUser? this.userMarkdownController : this.openclawMarkdownController;
  }

  private scheduleInitialScroll(): void {
    setTimeout(() => {
      this.messageScroller.scrollEdge(Edge.Bottom);
    }, 0);
    setTimeout(() => {
      this.messageScroller.scrollEdge(Edge.Bottom);
    }, 80);
    setTimeout(() => {
      this.messageScroller.scrollEdge(Edge.Bottom);
    }, 220);
  }

  private scheduleScrollToBottom(): void {
    const scrollToken = String(this.chatMessagesState.length) + '|' + this.chatStreamingTextState + '|' + String(this.chatPendingToolCallsState.length);
    if (scrollToken === this.lastScrollToken) {
      return;
    }
    this.lastScrollToken = scrollToken;
    setTimeout(() => {
      this.messageScroller.scrollEdge(Edge.Bottom);
    }, 0);
    setTimeout(() => {
      this.messageScroller.scrollEdge(Edge.Bottom);
    }, 60);
  }

  private friendlySessionName(name: string):string {
    if (!name || name.trim().length === 0) {
      return this.localizedText('common_main', 'Main');
    }
    return name === this.viewModel.mainSessionKey ? this.localizedText('common_main', 'Main') : name;
  }

  private bubbleSafeMarkdown(text: string): string {
    return text || '';
  }

  private localizedThinkingLevel(level: string): string {
    switch (level) {
      case 'off':
        return this.localizedText('chat_thinking_level_off', 'Off');
      case 'low':
        return this.localizedText('chat_thinking_level_low', 'Low');
      case 'medium':
        return this.localizedText('chat_thinking_level_medium', 'Medium');
      case 'high':
        return this.localizedText('chat_thinking_level_high', 'High');
      default:
        return level;
    }
  }

  private localizedThinking(level: string): string {
    return this.localizedText('chat_thinking_prefix', 'Thinking') + ' : ' + this.localizedThinkingLevel(level);
  }

  private messageListKey(message: ChatMessage, index: number): string {
    if ((message.stableKey || '').length > 0) {
      return message.stableKey;
    }

    const contentText = this.messageTextValue(message);
    if (contentText.length > 0) {
      return message.role + '|' + contentText + '|' + String(index);
    }
    return message.role + '|index|' + String(index);
  }

  private titleCase(value: string): string {
    if (value.length === 0) {
      return value;
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private sessionUpdatedText(updatedAtMs: number) {
    const now = Date.now();
    const diffMs = now - updatedAtMs;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const justNowText = this.localizedText('chat_updated_just_now', 'Updated just now');
    const minutesAgoText = this.localizedText('chat_updated_minutes_ago', 'm ago');
    const hoursAgoText = this.localizedText('chat_updated_hours_ago', 'h ago');

    if (diffMinutes < 1) {
      return justNowText;
    } else if (diffHours < 1) {
      return `${diffMinutes}${minutesAgoText}`;
    } else {
      return `${diffHours}${hoursAgoText}`;
    }
  }

  private localizedText(name: string, fallback: string): string {
    try {
      void this.localeVersion;
      return getContext(this).resourceManager.getStringByNameSync(name);
    } catch (error) {
      console.warn('ChatPage: localizedText failed for key: ' + name);
      return fallback;
    }
  }

  private messageTextValue(message: ChatMessage): string {
    if (!message.content || message.content.length === 0) {
      return '';
    }

    const textParts: string[] = [];
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      const blockType = (block.type || '').trim();
      const blockText = (block.text || '').trim();

      if (blockType === 'text' && blockText.length > 0) {
        textParts.push(blockText);
        continue;
      }

      if (blockType.length > 0 && blockType !== 'text') {
        textParts.push(`[${blockType}]`);
      }
    }

    return textParts.join('\n\n');
  }
}
