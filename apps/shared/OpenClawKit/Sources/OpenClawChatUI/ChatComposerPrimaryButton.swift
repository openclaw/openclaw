import OpenClawKit
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
                keepsReply: self.sendKeepsReply,
                fill: self.sendButtonFill,
                disabledFill: self.disabledSendButtonFill,
                ink: self.sendButtonForeground,
                borderOpacity: self.sendButtonBorderOpacity,
                queueModes: self.inputModel?.sendModeChoices ?? [],
                action: { mode in
                    self.markAwaitingReplyIfNeeded()
                    // The message leaves from the field this button sits in.
                    ChatSendEntrance.composerWillSend()
                    self.sendDraftIfEnabled(queueMode: mode)
                }),
            stop: .init(
                canStop: self.viewModel.pendingRunCount > 0,
                isAborting: self.viewModel.isAborting,
                ink: Color(uiColor: OpenClawIOSBrand.danger),
                action: { self.viewModel.abort() }),
            talkControl: self.talkControl,
            sessionKey: self.viewModel.sessionKey,
            controlSize: self.cleanControlHeight,
            visualSize: self.cleanIconControlSize)
            .onChange(of: self.replyMarkEnded) { _, ended in
                if ended { self.primaryReplyMark = nil }
            }
            .task(id: self.primaryReplyMark) {
                guard self.primaryReplyMark != nil else { return }
                do {
                    try await Task.sleep(for: Self.replyMarkTimeout)
                } catch {
                    return
                }
                self.primaryReplyMark = nil
            }
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

    var stopButtonFill: Color {
        #if os(iOS)
        OpenClawChatTheme.accent
        #else
        OpenClawChatTheme.danger
        #endif
    }

    var sendButtonFill: Color {
        #if os(iOS)
        OpenClawChatTheme.accent
        #else
        self.userAccent ?? OpenClawChatTheme.userBubble
        #endif
    }

    var disabledSendButtonFill: Color {
        #if os(iOS)
        let cleanFill = self.sendButtonFill.opacity(0.4)
        #else
        let cleanFill = Color.clear
        #endif
        return self.composerChrome == .clean ? cleanFill : Color.secondary.opacity(0.32)
    }

    var sendButtonForeground: Color {
        #if os(iOS)
        return self.canSendMessage || self.composerChrome == .full ? .white : .white.opacity(0.7)
        #else
        let disabledInk: Color = self.composerChrome == .full ? .white : .secondary.opacity(0.55)
        return self.canSendMessage ? OpenClawChatTheme.userText(on: self.userAccent) : disabledInk
        #endif
    }

    var sendButtonBorderOpacity: Double {
        if self.composerChrome == .clean, !self.canSendMessage {
            return 0
        }
        return self.canSendMessage ? 0.18 : 0.08
    }

    #if os(iOS)
    var phonePrimaryRole: ChatComposerPrimaryRole {
        ChatComposerPrimaryRole.resolve(
            // A tile, preparing or failed, keeps the button on a disabled Send instead of Talk:
            // a voice conversation would leave the tile sitting in the composer.
            hasDraftToSend: self.viewModel.hasDraftToSend || !self.viewModel.composerPreparingAttachments.isEmpty,
            // A tile still preparing goes with the message, so Send works while it prepares.
            canSendDraft: self.canSendMessage,
            hasOwnReply: self.viewModel.pendingRunCount > 0 ||
                (self.primaryReplyMark != nil && !self.replyMarkEnded),
            hasReplyRunningElsewhere: self.viewModel.hasAdvertisedLiveRun ||
                self.viewModel.hasActiveSessionRunWithoutChatSnapshot,
            hasBlockingRunActivity: self.viewModel.hasBlockingRunActivity,
            isLocalVoiceCaptureActive: self.isLocalVoiceCaptureActive,
            talk: self.talkControl.map { $0.isEnabled ? .live : .available } ?? .unavailable)
    }

    /// The reply normally registers within about a second (0.1 s live, up to 1 s through the
    /// outbox on the test Gateway); the Gateway's run advertisement keeps Stop after that.
    static let replyMarkTimeout: Duration = .seconds(2)

    /// Sending during a reply queues or steers it, except in the Gateway's interrupt mode.
    private var sendKeepsReply: Bool {
        (self.viewModel.defaultFollowUpMode?.rawValue ?? self.viewModel.currentSessionEntry()?.effectiveQueueMode)
            != "interrupt"
    }

    /// Marks a send that will ask for a reply, so the button turns into Stop at the tap instead of
    /// passing through Talk or a second Send while the message is saved and delivered.
    private func markAwaitingReplyIfNeeded() {
        guard self.canSendMessage, self.viewModel.healthOK else { return }
        let command = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !localSessionCommands.contains(command) else { return }
        self.primaryReplyMark = UUID()
    }

    /// Ends the mark: the reply registered (live Stop takes over), the message went to the offline
    /// queue, or the send gave the draft back.
    private var replyMarkEnded: Bool {
        self.viewModel.pendingRunCount > 0 || !self.viewModel.healthOK ||
            (!self.viewModel.isSubmittingDraft && !self.viewModel.isSending && self.viewModel.hasDraftToSend)
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
        /// Sending now leaves that reply running (every queue mode but interrupt).
        let keepsReply: Bool
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
        let action: () -> Void
    }

    let role: ChatComposerPrimaryRole
    let send: Send
    let stop: Stop
    let talkControl: OpenClawChatTalkControl?
    let sessionKey: String
    let controlSize: CGFloat
    let visualSize: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Stop arrives under the finger that just tapped Send, so it stays inert for a moment.
    @State private var isStopArmed = false
    /// Set by the Send tap so the swap to Stop lands in the next frame: the send keeps the main
    /// thread busy for a few hundred milliseconds, which held a cross-fade on Send that long.
    /// A refused send keeps it until the next role change, which then swaps without a fade.
    @State private var swapsWithoutFade = false

    var body: some View {
        // Inside the composer's glass, a face that changed in the same update as the card's height was
        // drawn against the card's old geometry, a row away from its slot, until the next update.
        // Resolving the button's position as one unit keeps every face in its slot.
        self.menuHost
            .buttonStyle(ChatComposerPrimaryButtonStyle())
            .disabled(self.isDisabled)
            // No `.help`: on iOS it sets the accessibility hint too and would fight the one below.
            .accessibilityLabel(Text(self.accessibility.label))
            .accessibilityValue(Text(self.accessibility.value))
            .accessibilityHint(Text(self.accessibility.hint))
            .accessibilityIdentifier(self.accessibilityIdentifier)
            .geometryGroup()
            .task(id: self.role) {
                self.isStopArmed = false
                self.swapsWithoutFade = false
                guard self.role == .stop else { return }
                do {
                    try await Task.sleep(for: .milliseconds(700))
                } catch {
                    return
                }
                self.isStopArmed = true
            }
    }

    /// A UIKit menu host can trail the composer's layout during a busy send. Use one only when
    /// there are actions; Send uses an anchored menu so the editor keeps its keyboard.
    @ViewBuilder
    private var menuHost: some View {
        if self.role == .send, self.send.isEnabled, !self.send.queueModes.isEmpty {
            Menu {
                self.menuItems
            } label: {
                self.buttonLabel
            } primaryAction: {
                self.perform()
            }
            .menuIndicator(.hidden)
        } else if self.role == .talk, self.talkControl?.selectInputDevice != nil {
            self.button.chatActionContextMenu { self.menuItems }
        } else {
            self.button
        }
    }

    private var button: some View {
        Button(action: self.perform) { self.buttonLabel }
    }

    private var buttonLabel: some View {
        // One face per role, stacked: a role change is one opacity cross-fade. Only opacity
        // animates, so the disc never slides when the card around it changes height.
        ZStack {
            self.face(for: .talk)
            self.face(for: .send)
            self.face(for: .stop)
        }
        .frame(width: self.controlSize, height: self.controlSize)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var menuItems: some View {
        switch self.role {
        case .send:
            ForEach(self.send.queueModes, id: \.self) { mode in
                Button {
                    self.swapsWithoutFade = true
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

    private func perform() {
        switch self.role {
        case .talk:
            self.talkControl?.toggle(self.sessionKey)
        case .send:
            self.swapsWithoutFade = true
            self.send.action(nil)
        case .stop:
            self.stop.action()
        }
    }

    /// Reduce Motion, and the swap a Send tap starts, change faces without a cross-fade.
    private var faceAnimation: Animation? {
        self.reduceMotion || self.swapsWithoutFade ? nil : .easeInOut(duration: 0.2)
    }

    private var isInertStop: Bool {
        self.role == .stop && (!self.isStopArmed || !self.stop.canStop)
    }

    private func face(for role: ChatComposerPrimaryRole) -> some View {
        self.glyph(for: role)
            .animation(self.faceAnimation) { $0.opacity(role == .stop && self.isInertStop ? 0.6 : 1) }
            .frame(width: self.visualSize, height: self.visualSize)
            .background {
                Circle().fill(self.fill(for: role))
            }
            .overlay {
                Circle().strokeBorder(Color.white.opacity(self.borderOpacity(for: role)), lineWidth: 1)
            }
            .animation(self.faceAnimation) { $0.opacity(self.role == role ? 1 : 0) }
    }

    @ViewBuilder
    private func glyph(for role: ChatComposerPrimaryRole) -> some View {
        // Only Stop shows progress; a send never turns the button into a spinner.
        if role == .stop, self.stop.isAborting {
            ProgressView().controlSize(.mini).tint(self.ink(for: role))
        } else {
            Image(systemName: self.symbolName(for: role))
                .font(self.symbolFont(for: role))
                .scaleEffect(role == .talk ? 0.88 : 1)
                .foregroundStyle(self.ink(for: role))
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

    private func symbolName(for role: ChatComposerPrimaryRole) -> String {
        switch role {
        // Live, the Talk face ends the conversation: a close mark reads as that at a glance.
        case .talk: self.talkControl?.isEnabled == true ? "xmark" : "waveform"
        case .send: "arrow.up"
        case .stop: "stop.fill"
        }
    }

    private func symbolFont(for role: ChatComposerPrimaryRole) -> Font {
        switch role {
        case .talk: OpenClawChatTypography.composerPrimaryGlyph
        case .send: .system(size: OpenClawChatTypography.scaled(18), weight: .semibold)
        case .stop: .system(size: OpenClawChatTypography.scaled(17), weight: .semibold)
        }
    }

    private func ink(for role: ChatComposerPrimaryRole) -> Color {
        switch role {
        case .talk: .white
        case .send: self.send.ink
        case .stop: self.stop.ink
        }
    }

    private func fill(for role: ChatComposerPrimaryRole) -> AnyShapeStyle {
        switch role {
        case .talk:
            guard let talkControl else { return AnyShapeStyle(OpenClawChatTheme.accent) }
            if talkControl.isEnabled {
                return AnyShapeStyle(OpenClawChatTheme.accent)
            }
            return AnyShapeStyle(OpenClawChatTheme.accent.opacity(talkControl.isGatewayConnected ? 1 : 0.4))
        case .send:
            return AnyShapeStyle(self.send.isEnabled ? self.send.fill : self.send.disabledFill)
        case .stop:
            // The Control UI uses the square’s ink at 14% behind it, with no outline.
            return AnyShapeStyle(self.stop.ink.opacity(0.14))
        }
    }

    private func borderOpacity(for role: ChatComposerPrimaryRole) -> Double {
        role == .send ? self.send.borderOpacity : 0
    }

    private var accessibility: ChatComposerPrimaryAccessibility {
        switch self.role {
        case .talk:
            let isActive = self.talkControl?.isEnabled == true
            return .talk(
                isActive: isActive,
                isConnected: self.talkControl?.isGatewayConnected == true,
                liveStatus: isActive ? self.talkControl.map { ChatTalkPresentation(control: $0).status } ?? "" : "")
        case .send:
            return .send(isReplyRunning: self.send.isReplyRunning, sendKeepsReply: self.send.keepsReply)
        case .stop:
            return .stop(canStop: self.stop.canStop, isStopping: self.stop.isAborting)
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

/// Press feedback like the app's interactive glass buttons: the disc swells under the finger.
/// It animates in only and snaps back on release, so it never blends into the role cross-fade
/// that the same release starts. Reduce Motion dims instead of scaling.
private struct ChatComposerPrimaryButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .animation(pressed ? .spring(duration: 0.18, bounce: 0.3) : nil) { content in
                content
                    .scaleEffect(pressed && !self.reduceMotion ? 1.08 : 1)
                    .opacity(pressed && self.reduceMotion ? 0.7 : 1)
            }
    }
}
#endif
