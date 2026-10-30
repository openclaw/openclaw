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

    struct Session {
        let token: UUID
        var text: String
        var sendChime: VoiceWakeChime
        var voiceWakeTrigger: String?
    }

    private var session: Session?

    // MARK: - API

    func startSession(
        text: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        voiceWakeTrigger: String? = nil) -> UUID
    {
        let token = UUID()
        self.session = Session(
            token: token,
            text: text,
            sendChime: .none,
            voiceWakeTrigger: voiceWakeTrigger)
        self.overlay.startSession(
            token: token,
            transcript: text,
            attributed: attributed,
            forwardEnabled: forwardEnabled,
            isFinal: false)
        return token
    }

    func updatePartial(token: UUID, text: String, attributed: NSAttributedString? = nil) {
        guard let session, session.token == token else { return }
        self.session?.text = text
        self.overlay.updatePartial(token: token, transcript: text, attributed: attributed)
    }

    func updateEditedText(token: UUID, text: String) {
        guard self.session?.token == token else { return }
        self.session?.text = text
    }

    func finalize(
        token: UUID,
        text: String,
        sendChime: VoiceWakeChime,
        autoSendAfter: TimeInterval?,
        voiceWakeTrigger: String? = nil)
    {
        guard let session, session.token == token else { return }
        self.session?.text = text
        self.session?.sendChime = sendChime
        if let voiceWakeTrigger {
            self.session?.voiceWakeTrigger = voiceWakeTrigger
        }

        self.overlay.presentFinal(
            token: token,
            transcript: text,
            autoSendAfter: autoSendAfter)
    }

    func sendNow(token: UUID) {
        guard let session, session.token == token else { return }
        let text = session.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceWakeTrigger = session.voiceWakeTrigger
        guard !text.isEmpty else {
            self.overlay.dismiss(token: token, reason: .empty, outcome: .empty)
            self.session = nil
            return
        }
        self.overlay.beginSendUI(token: token, sendChime: session.sendChime)
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
        self.session = nil
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard let session, session.token == token else { return }
        self.overlay.updateLevel(token: token, level)
    }

    func snapshot() -> (token: UUID?, text: String, visible: Bool) {
        (self.session?.token, self.session?.text ?? "", self.overlay.isVisible)
    }

    /// Overlay dismiss completion callback (manual X, empty, auto-dismiss after send).
    /// Ensures the wake-word recognizer is resumed if Voice Wake is enabled.
    func overlayDidDismiss(token: UUID) {
        if self.session?.token == token {
            self.session = nil
        }
        self.didDismiss(token)
    }
}
