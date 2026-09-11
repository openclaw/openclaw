import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class VoiceSessionCoordinator {
    static var shared: VoiceSessionCoordinator {
        AppStateStore.shared.voiceRuntime.sessions
    }

    private let overlay: VoiceWakeOverlayController
    private let forward: AppVoiceRuntime.Forward
    private let didDismiss: @MainActor @Sendable (UUID) -> Void

    init(
        overlay: VoiceWakeOverlayController,
        forward: @escaping AppVoiceRuntime.Forward,
        didDismiss: @escaping @MainActor @Sendable (UUID) -> Void)
    {
        self.overlay = overlay
        self.forward = forward
        self.didDismiss = didDismiss
    }

    enum Source: String { case wakeWord, pushToTalk }

    struct Session {
        let token: UUID
        let source: Source
        var text: String
        var attributed: NSAttributedString?
        var isFinal: Bool
        var sendChime: VoiceWakeChime
        var autoSendDelay: TimeInterval?
        var voiceWakeTrigger: String?
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.coordinator")
    private var session: Session?

    // MARK: - API

    func startSession(
        source: Source,
        text: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        voiceWakeTrigger: String? = nil) -> UUID
    {
        let token = UUID()
        self.logger.info("coordinator start token=\(token.uuidString) source=\(source.rawValue) len=\(text.count)")
        let attributedText = attributed ?? self.overlay.makeAttributed(from: text)
        let session = Session(
            token: token,
            source: source,
            text: text,
            attributed: attributedText,
            isFinal: false,
            sendChime: .none,
            autoSendDelay: nil,
            voiceWakeTrigger: voiceWakeTrigger)
        self.session = session
        self.overlay.startSession(
            token: token,
            source: VoiceWakeOverlayController.Source(rawValue: source.rawValue) ?? .wakeWord,
            transcript: text,
            attributed: attributedText,
            forwardEnabled: forwardEnabled,
            isFinal: false)
        return token
    }

    func updatePartial(token: UUID, text: String, attributed: NSAttributedString? = nil) {
        guard let session, session.token == token else { return }
        self.session?.text = text
        self.session?.attributed = attributed
        self.overlay.updatePartial(token: token, transcript: text, attributed: attributed)
    }

    func finalize(
        token: UUID,
        text: String,
        sendChime: VoiceWakeChime,
        autoSendAfter: TimeInterval?,
        voiceWakeTrigger: String? = nil)
    {
        guard let session, session.token == token else { return }
        self.logger
            .info(
                "coordinator finalize token=\(token.uuidString) len=\(text.count) autoSendAfter=\(autoSendAfter ?? -1)")
        self.session?.text = text
        self.session?.isFinal = true
        self.session?.sendChime = sendChime
        self.session?.autoSendDelay = autoSendAfter
        if let voiceWakeTrigger {
            self.session?.voiceWakeTrigger = voiceWakeTrigger
        }

        let attributed = self.overlay.makeAttributed(from: text)
        self.overlay.presentFinal(
            token: token,
            transcript: text,
            autoSendAfter: autoSendAfter,
            attributed: attributed)
    }

    func sendNow(token: UUID, reason: String = "explicit") {
        guard let session, session.token == token else { return }
        let text = session.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceWakeTrigger = session.voiceWakeTrigger
        let sendChime = session.sendChime
        guard !text.isEmpty else {
            self.logger.info("coordinator sendNow \(reason) empty -> dismiss")
            self.overlay.dismiss(token: token, reason: .empty, outcome: .empty)
            self.clearSession()
            return
        }
        self.overlay.beginSendUI(token: token, sendChime: sendChime)
        Task.detached { [forward] in
            _ = await forward(text, voiceWakeTrigger)
        }
    }

    func dismiss(
        token: UUID,
        reason: VoiceWakeOverlayController.DismissReason,
        outcome: VoiceWakeOverlayController.SendOutcome)
    {
        guard let session, session.token == token else { return }
        self.overlay.dismiss(token: token, reason: reason, outcome: outcome)
        self.clearSession()
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard let session, session.token == token else { return }
        self.overlay.updateLevel(token: token, level)
    }

    func snapshot() -> (token: UUID?, text: String, visible: Bool) {
        (self.session?.token, self.session?.text ?? "", self.overlay.isVisible)
    }

    // MARK: - Private

    private func clearSession() {
        self.session = nil
    }

    /// Overlay dismiss completion callback (manual X, empty, auto-dismiss after send).
    /// Ensures the wake-word recognizer is resumed if Voice Wake is enabled.
    func overlayDidDismiss(token: UUID) {
        if self.session?.token == token {
            self.clearSession()
        }
        self.didDismiss(token)
    }
}
