import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// What the composer says about a live voice conversation: one phrase, one live mark, one announcement.
/// The main button reads the same phrase as its value, so the two never disagree. The transcript keeps
/// its own turn status; nothing here describes the agent's work.
struct ChatTalkPresentation: Equatable {
    enum Mark: Equatable {
        case connecting
        /// Moves with the microphone (listening) or the agent's voice (speaking).
        case meter(listening: Bool)
        case muted
        /// The app's working claw, at rest: the transcript row above it is the one that moves.
        case thinking
        case issue
    }

    /// What the row shows: the state, or the person's words while they speak.
    let text: String
    /// The state alone. VoiceOver announces it when it changes and reads it as the main button's value.
    let status: String
    let mark: Mark
    /// The shown text is what the recognizer heard, so a long phrase keeps its end in view.
    let showsHeardWords: Bool
    /// An access issue the person fixes in Settings.
    let offersSettings: Bool

    init(control: OpenClawChatTalkControl) {
        let heard = control.partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        var showsHeardWords = false
        var offersSettings = false
        let status: String
        let mark: Mark
        switch control.resolvedPhase {
        case .connecting:
            status = String(localized: "Connecting…")
            mark = .connecting
        case .listening where control.isMicrophoneMuted:
            status = String(localized: "Muted")
            mark = .muted
        case .listening:
            status = String(localized: "Listening")
            mark = .meter(listening: true)
            showsHeardWords = !heard.isEmpty
        case .thinking:
            status = String(localized: "Waiting for a reply")
            mark = .thinking
        case .speaking:
            status = String(localized: "Speaking")
            mark = .meter(listening: false)
        case let .issue(issue):
            status = Self.text(for: issue)
            mark = .issue
            offersSettings = (issue == .microphoneAccess || issue == .speechRecognitionAccess) &&
                control.openSettings != nil
        }
        self.status = status
        self.text = showsHeardWords ? heard : status
        self.mark = mark
        self.showsHeardWords = showsHeardWords
        self.offersSettings = offersSettings
    }

    static func text(for issue: OpenClawChatTalkIssue) -> String {
        switch issue {
        case .microphoneAccess: String(localized: "No mic access")
        case .speechRecognitionAccess: String(localized: "No speech access")
        case .offline: String(localized: "Offline")
        case .notAllowed: String(localized: "Talk needs approval")
        case .approvalRequested: String(localized: "Waiting for approval")
        case .startFailed: String(localized: "Couldn’t start Talk")
        case .replyFailed: String(localized: "Couldn’t get a reply")
        case .speechFailed: String(localized: "Couldn’t play audio")
        }
    }
}

extension OpenClawChatTalkControl {
    /// The state as the Talk row says it, for any other place that names it (the chat header's VoiceOver label).
    public var statusPhrase: String {
        ChatTalkPresentation(control: self).status
    }
}

#if os(iOS)
/// The composer card while Talk is on: it takes the place of the draft's row, in the same height.
/// Mute leads where "+" sits; the state and its live mark fill the field's place; the camera and
/// the main button (End Talk) keep their slots on the trailing side.
@MainActor
struct ChatTalkComposerRow<Trailing: View>: View {
    let control: OpenClawChatTalkControl
    let controlHeight: CGFloat
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    var body: some View {
        let presentation = ChatTalkPresentation(control: self.control)
        HStack(spacing: 0) {
            // Mute does nothing while an issue keeps the microphone closed; the issue's action takes the room.
            let showsMute = self.control.toggleMicrophone != nil && presentation.mark != .issue
            if showsMute, let toggleMicrophone = self.control.toggleMicrophone {
                self.muteButton(toggleMicrophone)
            }
            self.state(presentation)
                .padding(.leading, showsMute ? 0 : CleanChatComposerMetrics.editorInlineInset)
                .frame(maxWidth: .infinity, alignment: .leading)
            self.trailing()
        }
        .frame(minHeight: self.controlHeight)
        .padding(CleanChatComposerMetrics.collapsedControlInset)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-talk-row")
        .onChange(of: presentation.status) { _, status in
            // Once per change of state; the heard words are never announced over the person's voice.
            guard self.voiceOverEnabled else { return }
            AccessibilityNotification.Announcement(status).post()
        }
    }

    private func muteButton(_ toggle: @escaping @MainActor () -> Void) -> some View {
        let muted = self.control.isMicrophoneMuted
        return Button(action: toggle) {
            Image(systemName: muted ? "mic.slash" : "mic")
                .font(OpenClawChatTypography.composerGlyph)
                .foregroundStyle(CleanChatComposerMetrics.footerInk)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: self.controlHeight, height: self.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // As in the Phone app: one Mute button that reads as selected while the microphone is off.
        .accessibilityLabel(Text("Mute"))
        .accessibilityAddTraits(muted ? .isSelected : [])
        .accessibilityIdentifier("chat-talk-microphone")
    }

    private func state(_ presentation: ChatTalkPresentation) -> some View {
        HStack(spacing: 8) {
            self.mark(presentation.mark)
                .frame(width: 28, height: 20)
                .accessibilityHidden(true)
            Text(presentation.text)
                .font(OpenClawChatTypography.body)
                .foregroundStyle(presentation.showsHeardWords ? .primary : CleanChatComposerMetrics.footerStrongInk)
                .lineLimit(self.dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .truncationMode(presentation.showsHeardWords ? .head : .tail)
                .accessibilityLabel(Text(presentation.status))
                .accessibilityIdentifier("chat-talk-status")
            if presentation.offersSettings, let openSettings = self.control.openSettings {
                Button(action: openSettings) {
                    Text("Settings")
                        .font(OpenClawChatTypography.body)
                        .fontWeight(.semibold)
                        .foregroundStyle(.primary)
                        .frame(minHeight: self.controlHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Open Settings"))
                .accessibilityIdentifier("chat-talk-open-settings")
            }
        }
    }

    @ViewBuilder
    private func mark(_ mark: ChatTalkPresentation.Mark) -> some View {
        switch mark {
        case .connecting:
            ProgressView().controlSize(.small).tint(CleanChatComposerMetrics.footerInk)
        case let .meter(listening):
            TalkWaveformView(
                phase: listening
                    ? .listening(
                        level: self.control.resolvedLevel,
                        speechActive: !self.control.partialTranscript.isEmpty)
                    : .speaking(level: self.control.resolvedLevel),
                palette: Self.neutralPalette)
        case .muted:
            TalkWaveformView(phase: .idle, palette: Self.neutralPalette)
        case .thinking:
            ChatWorkingClawView(seed: "talk-thinking", parked: true, tint: CleanChatComposerMetrics.footerInk)
                .scaleEffect(0.8)
        case .issue:
            Image(systemName: "exclamationmark.circle")
                .font(OpenClawChatTypography.composerGlyph)
                .foregroundStyle(CleanChatComposerMetrics.footerInk)
        }
    }

    private static var neutralPalette: TalkWaveformPalette {
        chatTalkNeutralPalette
    }
}

/// The live mark in the composer's own ink: color stays with the main button.
private let chatTalkNeutralPalette = TalkWaveformPalette(
    active: [.primary.opacity(0.7), .primary.opacity(0.45), .primary.opacity(0.25)],
    inactive: [.primary.opacity(0.3)])
#endif

#if os(iOS)
extension OpenClawChatComposer {
    /// While Talk is on, the card is the Talk surface: its row takes the draft's place in the same card.
    /// The draft stays mounted out of sight, so its text, selection and attachments are there when Talk ends.
    var cleanComposerCardContent: some View {
        VStack(spacing: 0) {
            self.cleanComposerDraft
                .modifier(ChatTalkDraftHold(isHeld: self.isTalkLive))
            if self.isTalkLive, let talkControl {
                self.talkRow(talkControl)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .modifier(ChatTalkTransition(isTalkLive: self.isTalkLive, isFocused: self.$isFocused))
    }

    var isTalkLive: Bool {
        self.composerChrome == .clean && self.talkControl?.isEnabled == true
    }

    func talkRow(_ control: OpenClawChatTalkControl) -> some View {
        // The trailing slots are the composer's own: the camera when Talk offers it, then the main button.
        ChatTalkComposerRow(control: control, controlHeight: self.cleanControlHeight) {
            self.cleanCaptureAndPrimaryControls
        }
        .transition(.opacity)
    }
}

/// Keeps the draft mounted and out of sight while Talk is on: no height, no hit testing, hidden from
/// VoiceOver. Its text view keeps its text and selection, and its tiles stay staged.
struct ChatTalkDraftHold: ViewModifier {
    let isHeld: Bool

    func body(content: Content) -> some View {
        content
            .frame(height: self.isHeld ? 0 : nil, alignment: .top)
            .opacity(self.isHeld ? 0 : 1)
            .allowsHitTesting(!self.isHeld)
            .accessibilityHidden(self.isHeld)
    }
}

/// Entering and leaving Talk is one cross-fade of the card's content; the card keeps its place.
/// Talk puts the keyboard away, since the draft it would type into is held.
struct ChatTalkTransition: ViewModifier {
    let isTalkLive: Bool
    @Binding var isFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            // Content entering and leaving in place: ease-out, as short as the main button's own cross-fade.
                .animation(self.reduceMotion ? nil : .easeOut(duration: 0.2), value: self.isTalkLive)
                .onChange(of: self.isTalkLive, initial: true) { _, live in
                    guard live else { return }
                    // A false focus request is not a blur in the text view, so put the keyboard away directly.
                    self.isFocused = false
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil,
                        from: nil,
                        for: nil)
                }
    }
}
#endif
