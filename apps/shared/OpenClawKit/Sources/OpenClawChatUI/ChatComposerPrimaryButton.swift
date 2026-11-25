import SwiftUI

extension OpenClawChatComposer {
    /// The composer's primary control. On iOS one button that is Talk, Send or Stop; elsewhere the
    /// iMessage-style Talk affordance while the draft is empty, swapping to Send once the user types.
    @ViewBuilder
    var cleanTrailingControl: some View {
        #if os(iOS)
        ChatComposerPrimaryButton(
            role: self.phonePrimaryRole,
            send: .init(
                isEnabled: self.canSendMessage,
                isReplyRunning: self.viewModel.pendingRunCount > 0,
                fill: self.sendButtonFill,
                disabledFill: self.disabledSendButtonFill,
                ink: self.sendButtonForeground,
                borderOpacity: self.sendButtonBorderOpacity,
                queueModes: self.inputModel?.sendModeChoices ?? [],
                action: { self.sendDraftIfEnabled(queueMode: $0) }),
            stop: .init(
                canStop: self.viewModel.pendingRunCount > 0,
                isAborting: self.viewModel.isAborting,
                ink: self.stopButtonForeground,
                fill: self.stopButtonFill,
                action: { self.viewModel.abort() }),
            talkControl: self.talkControl,
            talkHelpText: self.talkControl.map { self.talkHelpText($0) } ?? "",
            sessionKey: self.viewModel.sessionKey,
            controlSize: self.cleanControlHeight,
            visualSize: self.cleanIconControlSize)
        #else
        if Self.showsCompactTalkControl(
            hasDraftToSend: self.viewModel.hasDraftToSend,
            hasBlockingRunActivity: self.viewModel.hasBlockingRunActivity,
            isLocalVoiceCaptureActive: self.isLocalVoiceCaptureActive),
            let talkControl
        {
            ChatTalkButton(
                control: talkControl,
                sessionKey: self.viewModel.sessionKey,
                helpText: self.talkHelpText(talkControl),
                style: .compact(
                    controlHeight: cleanControlHeight,
                    iconControlSize: cleanIconControlSize))
        } else {
            sendButton
                .frame(width: cleanControlHeight, height: cleanControlHeight)
        }
        #endif
    }

    #if os(iOS)
    var phonePrimaryRole: ChatComposerPrimaryRole {
        ChatComposerPrimaryRole.resolve(
            hasDraftToSend: self.viewModel.hasDraftToSend,
            canSendDraft: self.canSendMessage,
            hasStoppableReply: self.viewModel.pendingRunCount > 0,
            hasReplyRunningElsewhere: self.viewModel.hasAdvertisedLiveRun ||
                self.viewModel.hasActiveSessionRunWithoutChatSnapshot,
            hasBlockingRunActivity: self.viewModel.hasBlockingRunActivity,
            isLocalVoiceCaptureActive: self.isLocalVoiceCaptureActive,
            hasTalkControl: self.talkControl != nil)
    }
    #endif

    private var isLocalVoiceCaptureActive: Bool {
        self.dictationTask != nil ||
            self.dictationControl?.isActive == true ||
            self.voiceNoteControl?.recorder.isRecording == true ||
            self.voiceNoteControl?.recorder.isRequestingPermission == true
    }
}

#if os(iOS)
/// The phone composer's one primary button: Talk, Send or Stop in the same frame.
/// Its glyph changes with a symbol replace, and its action, label and hint follow the role.
@MainActor
struct ChatComposerPrimaryButton: View {
    struct Send {
        let isEnabled: Bool
        /// A reply is running, so Send stands where Stop would be.
        let isReplyRunning: Bool
        let fill: Color
        let disabledFill: Color
        let ink: Color
        let borderOpacity: Double
        let queueModes: [OpenClawChatQueueMode]
        let action: (OpenClawChatQueueMode?) -> Void
    }

    struct Stop {
        /// False while the running reply is not one this client can abort yet.
        let canStop: Bool
        let isAborting: Bool
        let ink: Color
        let fill: Color
        let action: () -> Void
    }

    let role: ChatComposerPrimaryRole
    let send: Send
    let stop: Stop
    let talkControl: OpenClawChatTalkControl?
    let talkHelpText: String
    let sessionKey: String
    let controlSize: CGFloat
    let visualSize: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Stop arrives under the finger that just tapped Send, so it stays inert for a moment.
    @State private var isStopArmed = false

    var body: some View {
        Button(action: self.perform) {
            self.glyph
                .frame(width: self.visualSize, height: self.visualSize)
                .background {
                    Circle().fill(self.fill)
                }
                .overlay {
                    Circle().strokeBorder(Color.white.opacity(self.borderOpacity), lineWidth: 1)
                }
                .opacity(self.role == .stop && (!self.isStopArmed || !self.stop.canStop) ? 0.35 : 1)
                .frame(width: self.controlSize, height: self.controlSize)
                .contentShape(Rectangle())
                .animation(self.reduceMotion ? nil : .snappy(duration: 0.2), value: self.role)
        }
        .buttonStyle(.plain)
        .disabled(self.isDisabled)
        .accessibilityLabel(self.accessibilityLabel)
        .accessibilityHint(self.accessibilityHint)
        .accessibilityValue(self.role == .talk ? self.talkControl?.accessibilityStatus ?? "" : "")
        .accessibilityIdentifier(self.accessibilityIdentifier)
        .help(self.role == .talk ? self.talkHelpText : "")
        .chatActionContextMenu {
            switch self.role {
            case .send:
                ForEach(self.send.isEnabled ? self.send.queueModes : [], id: \.self) { mode in
                    Button {
                        self.send.action(mode)
                    } label: {
                        switch mode {
                        case .steer:
                            Label("Steer now", systemImage: "arrow.turn.up.right")
                                .font(OpenClawChatTypography.body)
                        case .followup:
                            Label("Queue next", systemImage: "clock")
                                .font(OpenClawChatTypography.body)
                        }
                    }
                }
            case .talk:
                if let talkControl {
                    ChatTalkInputDeviceMenu(control: talkControl)
                }
            case .stop:
                EmptyView()
            }
        }
        .task(id: self.role) {
            self.isStopArmed = false
            guard self.role == .stop else { return }
            do {
                try await Task.sleep(for: .milliseconds(700))
            } catch {
                return
            }
            self.isStopArmed = true
        }
    }

    private func perform() {
        switch self.role {
        case .talk:
            self.talkControl?.toggle(self.sessionKey)
        case .send:
            self.send.action(nil)
        case .stop:
            self.stop.action()
        }
    }

    @ViewBuilder
    private var glyph: some View {
        // Only Stop shows progress; a send never turns the button into a spinner.
        if self.role == .stop, self.stop.isAborting {
            ProgressView().controlSize(.mini).tint(self.ink)
        } else if self.role == .talk, let talkControl, talkControl.isEnabled {
            ChatTalkButtonGlyph(control: talkControl)
                .font(OpenClawChatTypography.composerPrimaryGlyph)
                .scaleEffect(0.88)
                .foregroundStyle(self.ink)
        } else {
            Image(systemName: self.symbolName)
                .font(self.symbolFont)
                .scaleEffect(self.role == .talk ? 0.88 : 1)
                .foregroundStyle(self.ink)
                .contentTransition(self.reduceMotion ? .identity : .symbolEffect(.replace))
        }
    }

    private var isDisabled: Bool {
        switch self.role {
        case .talk:
            guard let talkControl else { return true }
            return !talkControl.isGatewayConnected && !talkControl.isEnabled
        case .send:
            return !self.send.isEnabled
        case .stop:
            return !self.stop.canStop || self.stop.isAborting || !self.isStopArmed
        }
    }

    private var symbolName: String {
        switch self.role {
        case .talk: "waveform"
        case .send: "arrow.up"
        case .stop: "stop.fill"
        }
    }

    private var symbolFont: Font {
        switch self.role {
        case .talk: OpenClawChatTypography.composerPrimaryGlyph
        case .send: .system(size: OpenClawChatTypography.scaled(18), weight: .semibold)
        case .stop: .system(size: OpenClawChatTypography.scaled(17), weight: .semibold)
        }
    }

    private var ink: Color {
        switch self.role {
        case .talk: .white
        case .send: self.send.ink
        case .stop: self.stop.ink
        }
    }

    private var fill: AnyShapeStyle {
        switch self.role {
        case .talk:
            guard let talkControl else { return AnyShapeStyle(OpenClawChatTheme.accent) }
            if talkControl.isEnabled {
                return AnyShapeStyle(OpenClawChatTheme.userBubble)
            }
            return AnyShapeStyle(OpenClawChatTheme.accent.opacity(talkControl.isGatewayConnected ? 1 : 0.4))
        case .send:
            return AnyShapeStyle(self.send.isEnabled ? self.send.fill : self.send.disabledFill)
        case .stop:
            return AnyShapeStyle(self.stop.fill)
        }
    }

    private var borderOpacity: Double {
        self.role == .send ? self.send.borderOpacity : 0
    }

    private var accessibilityLabel: Text {
        switch self.role {
        case .talk:
            if self.talkControl?.isEnabled == true {
                Text("Stop realtime chat")
            } else {
                Text("Start realtime chat")
            }
        case .send:
            Text(verbatim: "Send message")
        case .stop:
            Text("Stop response")
        }
    }

    private var accessibilityHint: Text {
        switch self.role {
        case .talk:
            if self.talkControl?.isEnabled == true {
                Text("Ends the voice conversation.")
            } else {
                Text("Starts a voice conversation in this chat.")
            }
        case .send:
            if self.send.isReplyRunning {
                Text("Sends your message while the reply continues. To stop the reply, clear the field.")
            } else {
                Text("Sends your message.")
            }
        case .stop:
            Text("Stops the current reply.")
        }
    }

    private var accessibilityIdentifier: String {
        switch self.role {
        case .talk: "chat-realtime-control"
        case .send: "chat-send-message"
        case .stop: "chat-stop-response"
        }
    }
}
#endif
