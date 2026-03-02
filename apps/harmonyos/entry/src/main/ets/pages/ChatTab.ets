import { NodeRuntime } from '../node/NodeRuntime';
import { ChatController } from '../node/chat/ChatController';
import { ChatMessage, ChatMessageContent, OutgoingAttachment } from '../node/chat/ChatModels';
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x3D00;
const TAG = 'ChatTab';

@Component
export struct ChatTab {
  runtime: NodeRuntime | undefined = undefined;

  @State messages: ChatMessage[] = [];
  @State inputText: string = "";
  @State isSending: boolean = false;
  @State thinkingLevel: string = "off";
  @State streamingText: string | undefined = undefined;
  @State errorText: string | undefined = undefined;
  @State healthOk: boolean = true;
  @State sessionLabel: string = "HarmonyOS Node";
  @State showThinkingMenu: boolean = false;
  @State pendingAttachments: OutgoingAttachment[] = [];

  private scroller: Scroller = new Scroller();

  aboutToAppear() {
    const ctrl = this.runtime?.chatController;
    if (ctrl) {
      this.syncFromController(ctrl);

      ctrl.onChatUpdate = () => {
        this.syncFromController(ctrl);
      };

      ctrl.refresh();
    }
    this.sessionLabel = "HarmonyOS Node";
  }

  private syncFromController(ctrl: ChatController) {
    this.messages = [...ctrl.messages];
    this.thinkingLevel = ctrl.thinkingLevel;
    this.streamingText = ctrl.streamingAssistantText;
    this.errorText = ctrl.errorText;
    this.isSending = ctrl.pendingRunCount > 0;
    this.healthOk = ctrl.healthOk;
    // Auto-scroll to bottom
    setTimeout(() => {
      this.scroller.scrollEdge(Edge.Bottom);
    }, 50);
  }

  private thinkingLabel(raw: string): string {
    switch (raw.trim().toLowerCase()) {
      case "low": return "Low";
      case "medium": return "Medium";
      case "high": return "High";
      default: return "Off";
    }
  }

  private nextThinkingLevel(): string {
    const levels: string[] = ["off", "low", "medium", "high"];
    const idx = levels.indexOf(this.thinkingLevel.trim().toLowerCase());
    return levels[(idx + 1) % levels.length];
  }

  private async selectImages() {
    try {
      const photoSelectOptions = new picker.PhotoSelectOptions();
      photoSelectOptions.MIMEType = picker.PhotoViewMIMETypes.IMAGE_TYPE;
      photoSelectOptions.maxSelectNumber = 5;
      const photoPicker = new picker.PhotoViewPicker();
      const res = await photoPicker.select(photoSelectOptions);
      if (res && res.photoUris.length > 0) {
        for (const uri of res.photoUris) {
          await this.addAttachmentFromUri(uri, 'image');
        }
      }
    } catch (err) {
      const error = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'Photo picker failed: %{public}s', error.message);
    }
  }

  private async selectFiles() {
    try {
      const documentSelectOptions = new picker.DocumentSelectOptions();
      documentSelectOptions.maxSelectNumber = 5;
      const documentPicker = new picker.DocumentViewPicker();
      const res = await documentPicker.select(documentSelectOptions);
      if (res && res.length > 0) {
        for (const uri of res) {
          await this.addAttachmentFromUri(uri, 'file');
        }
      }
    } catch (err) {
      const error = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'Document picker failed: %{public}s', error.message);
    }
  }

  private async addAttachmentFromUri(uri: string, type: string) {
    try {
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const stat = fs.statSync(file.fd);
      const fileName = uri.split('/').pop() || (type === 'image' ? 'image.jpg' : 'file');
      
      // Limit size to 10MB for safety in base64
      if (stat.size > 10 * 1024 * 1024) {
        this.errorText = "File too large (>10MB)";
        fs.closeSync(file);
        return;
      }

      const buffer = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buffer);
      
      const helper = new util.Base64Helper();
      const base64 = helper.encodeToStringSync(new Uint8Array(buffer));
      
      const mimeType = type === 'image' ? 'image/jpeg' : 'application/octet-stream';
      
      this.pendingAttachments.push({
        type: type,
        mimeType: mimeType,
        fileName: fileName,
        base64: base64
      });
      
      fs.closeSync(file.fd);
    } catch (err) {
      const error = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'Add attachment failed: %{public}s', error.message);
    }
  }

  private removeAttachment(index: number) {
    this.pendingAttachments.splice(index, 1);
  }

  build() {
    Column() {
      // ── Message Area (Card) ──
      Column() {
        List({ scroller: this.scroller }) {
          ForEach(this.messages, (msg: ChatMessage) => {
            ListItem() { this.MessageBubble(msg) }
          }, (msg: ChatMessage) => msg.id)

          // Streaming text
          if (this.streamingText) {
            ListItem() { this.StreamingBubble(this.streamingText!) }
          }

          // Typing indicator
          if (this.isSending && !this.streamingText) {
            ListItem() { this.TypingIndicator() }
          }
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      }
      .layoutWeight(1)
      .width('100%')
      .margin({ left: 12, right: 12, top: 12 })
      .borderRadius(20)
      .backgroundColor('#F0F4F8')
      .clip(true)

      // ── Composer Panel ──
      Column() {
        // Top toolbar row: session + thinking + refresh + attach
        Scroll(new Scroller()) {
          Row() {
            // Session selector button
            Button(this.sessionLabel)
              .type(ButtonType.Capsule)
              .backgroundColor('#E8ECF0')
              .fontColor('#333333')
              .fontSize(14)
              .height(36)
              .fontWeight(FontWeight.Medium)

            // Thinking level button
            Button(`🧠 ${this.thinkingLabel(this.thinkingLevel)}`)
              .type(ButtonType.Capsule)
              .backgroundColor('#E8ECF0')
              .fontColor('#333333')
              .fontSize(14)
              .height(36)
              .margin({ left: 8 })
              .onClick(() => {
                const next = this.nextThinkingLevel();
                this.thinkingLevel = next;
                this.runtime?.chatController?.setThinkingLevel(next);
              })

            // Refresh button
            Button("↻")
              .type(ButtonType.Circle)
              .backgroundColor('#E8ECF0')
              .fontColor('#333333')
              .fontSize(18)
              .width(36)
              .height(36)
              .margin({ left: 8 })
              .onClick(() => {
                this.runtime?.chatController?.refresh();
              })

            // Attachment buttons
            Button("🖼️")
              .type(ButtonType.Circle)
              .backgroundColor('#E8ECF0')
              .fontColor('#333333')
              .fontSize(16)
              .width(36)
              .height(36)
              .margin({ left: 8 })
              .onClick(() => this.selectImages())

            Button("📎")
              .type(ButtonType.Circle)
              .backgroundColor('#E8ECF0')
              .fontColor('#333333')
              .fontSize(16)
              .width(36)
              .height(36)
              .margin({ left: 8 })
              .onClick(() => this.selectFiles())
          }
          .padding({ left: 10, right: 10 })
        }
        .width('100%')
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .padding({ top: 10 })

        // Text input
        TextInput({ text: this.inputText, placeholder: 'Message OpenClaw...' })
          .width('100%')
          .height(this.pendingAttachments.length > 0 ? 60 : 80)
          .borderRadius(12)
          .backgroundColor(Color.White)
          .padding({ left: 12, right: 12 })
          .margin({ left: 10, right: 10, top: 4 })
          .onChange((val: string) => this.inputText = val)
          .onSubmit(() => this.send())

        // Attachment Preview Area
        if (this.pendingAttachments.length > 0) {
          Scroll(new Scroller()) {
            Row() {
              ForEach(this.pendingAttachments, (att: OutgoingAttachment, index: number) => {
                this.AttachmentPreview(att, index)
              })
            }
            .padding({ left: 10, right: 10, bottom: 8 })
          }
          .scrollable(ScrollDirection.Horizontal)
          .width('100%')
        }

        // Bottom row: connection pill + send/abort button
        Row() {
          // Connection pill
          Row() {
            Text("●")
              .fontSize(8)
              .fontColor(this.healthOk ? '#2ECC71' : '#F39C12')
              .margin({ right: 6 })
            Text(this.sessionLabel)
              .fontSize(12)
              .fontColor('#333333')
              .fontWeight(FontWeight.Medium)
            Text(this.healthOk ? "  Connected" : "  Connecting…")
              .fontSize(12)
              .fontColor('#999999')
          }
          .height(28)
          .padding({ left: 10, right: 10 })
          .borderRadius(14)
          .backgroundColor('#E8ECF0')

          Blank()

          if (this.isSending) {
            // Abort button
            Button("■")
              .type(ButtonType.Circle)
              .width(40)
              .height(40)
              .fontSize(16)
              .backgroundColor('#33E74C3C')
              .fontColor('#E74C3C')
              .onClick(() => {
                // abort not yet ported
              })
          } else {
            // Send button
            Button("↑")
              .type(ButtonType.Circle)
              .width(40)
              .height(40)
              .fontSize(20)
              .fontWeight(FontWeight.Bold)
              .backgroundColor(this.canSend() ? '#0A59F7' : '#CCCCCC')
              .fontColor(Color.White)
              .enabled(this.canSend())
              .onClick(() => {
                this.send();
              })
          }
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 6, bottom: 10 })
        .alignItems(VerticalAlign.Center)

        // Error text
        if (this.errorText) {
          Text(this.errorText)
            .fontSize(12)
            .fontColor('#E53935')
            .padding({ left: 10, right: 10, bottom: 8 })
            .maxLines(2)
        }
      }
      .width('100%')
      .backgroundColor('#E8ECF0')
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FAFAFA')
  }

  @Builder AttachmentPreview(att: OutgoingAttachment, index: number) {
    Stack({ alignContent: Alignment.TopEnd }) {
      if (att.type === 'image') {
        Image(`data:${att.mimeType};base64,${att.base64}`)
          .width(60)
          .height(60)
          .borderRadius(8)
          .objectFit(ImageFit.Cover)
      } else {
        Column() {
          Text("📄")
            .fontSize(20)
          Text(att.fileName)
            .fontSize(8)
            .maxLines(1)
            .fontColor('#666666')
        }
        .width(60)
        .height(60)
        .borderRadius(8)
        .backgroundColor('#FFFFFF')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .padding(4)
      }

      // Close/Delete button
      Circle({ width: 18, height: 18 })
        .fill('#CC000000')
        .onClick(() => this.removeAttachment(index))
        .offset({ x: 4, y: -4 })
      
      Text("✕")
        .fontSize(10)
        .fontColor(Color.White)
        .hitTestBehavior(HitTestMode.None)
        .offset({ x: 4, y: -4 })
    }
    .width(64)
    .height(64)
    .margin({ right: 10 })
  }

  @Builder MessageBubble(msg: ChatMessage) {
    // Filter displayable content
    Column() {
      if (this.isUserMessage(msg)) {
        // User bubble — right-aligned, teal gradient
        Row() {
          Blank()
          Column() {
            ForEach(msg.content, (part: ChatMessageContent) => {
              if (part.type === 'text' && part.text) {
                Text(part.text)
                  .fontSize(15)
                  .fontColor(Color.White)
                  .lineHeight(22)
              } else if (part.type === 'image' && part.base64) {
                Image(`data:${part.mimeType || 'image/jpeg'};base64,${part.base64}`)
                  .width(200)
                  .borderRadius(8)
                  .margin({ top: 4, bottom: 4 })
              } else if (part.type !== 'text') {
                Row() {
                  Text("📄")
                    .margin({ right: 6 })
                  Text(part.fileName || 'file')
                    .fontSize(14)
                    .fontColor(Color.White)
                    .maxLines(1)
                }
                .padding(8)
                .backgroundColor('#20FFFFFF')
                .borderRadius(8)
                .margin({ top: 4, bottom: 4 })
              }
            })
          }
          .padding({ left: 14, right: 14, top: 10, bottom: 10 })
          .borderRadius(16)
          .backgroundColor('#1A9E96')
          .constraintSize({ maxWidth: '85%' })
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
      } else {
        // Assistant bubble — left-aligned, light surface
        Row() {
          Column() {
            ForEach(msg.content, (part: ChatMessageContent) => {
              if (part.type === 'text' && part.text) {
                Text(part.text)
                  .fontSize(15)
                  .fontColor('#333333')
                  .lineHeight(22)
              } else if (part.type === 'image' && part.base64) {
                Image(`data:${part.mimeType || 'image/jpeg'};base64,${part.base64}`)
                  .width(200)
                  .borderRadius(8)
                  .margin({ top: 4, bottom: 4 })
              } else if (part.type !== 'text') {
                Row() {
                  Text("📄")
                    .margin({ right: 6 })
                  Text(part.fileName || 'file')
                    .fontSize(14)
                    .fontColor('#333333')
                    .maxLines(1)
                }
                .padding(8)
                .backgroundColor('#F0F4F8')
                .borderRadius(8)
                .margin({ top: 4, bottom: 4 })
              }
            })
          }
          .padding({ left: 14, right: 14, top: 10, bottom: 10 })
          .borderRadius(16)
          .backgroundColor(Color.Transparent)
          .constraintSize({ maxWidth: '92%' })
          Blank()
        }
        .width('100%')
        .justifyContent(FlexAlign.Start)
      }
    }
    .margin({ top: 4, bottom: 4 })
  }

  @Builder StreamingBubble(text: string) {
    Row() {
      Column() {
        Text(text)
          .fontSize(15)
          .fontColor('#333333')
          .lineHeight(22)
      }
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .borderRadius(16)
      .backgroundColor('#E8ECF0')
      .constraintSize({ maxWidth: '92%' })
      Blank()
    }
    .width('100%')
    .justifyContent(FlexAlign.Start)
    .margin({ top: 4, bottom: 4 })
  }

  @Builder TypingIndicator() {
    Row() {
      Row() {
        Text("●")
          .fontSize(6)
          .fontColor('#999999')
          .opacity(0.4)
          .margin({ right: 4 })
        Text("●")
          .fontSize(6)
          .fontColor('#999999')
          .opacity(0.65)
          .margin({ right: 4 })
        Text("●")
          .fontSize(6)
          .fontColor('#999999')
          .opacity(0.9)
          .margin({ right: 8 })
        Text("Thinking…")
          .fontSize(14)
          .fontColor('#999999')
      }
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .borderRadius(16)
      .backgroundColor('#E8ECF0')
      Blank()
    }
    .width('100%')
    .justifyContent(FlexAlign.Start)
    .margin({ top: 4, bottom: 4 })
  }

  // ── Helpers ──

  private isUserMessage(msg: ChatMessage): boolean {
    return msg.role.toLowerCase() === 'user';
  }

  private canSend(): boolean {
    return !this.isSending && (this.inputText.trim().length > 0 || this.pendingAttachments.length > 0) && this.healthOk;
  }

  private send() {
    if (!this.canSend()) return;
    const msg = this.inputText;
    this.inputText = "";
    const atts = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.runtime?.chatController?.sendMessage(msg, this.thinkingLevel, atts);
  }
}
