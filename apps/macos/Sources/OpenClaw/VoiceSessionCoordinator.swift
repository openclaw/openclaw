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
    private let prepareForward: AppVoiceRuntime.PrepareForward
    private let forward: AppVoiceRuntime.Forward
    private let didDismiss: @MainActor @Sendable (UUID) -> Void

    init(
        overlay: VoiceWakeOverlayController,
        prepareForward: @escaping AppVoiceRuntime.PrepareForward,
        forward: @escaping AppVoiceRuntime.Forward,
        didDismiss: @escaping @MainActor @Sendable (UUID) -> Void)
    {
        self.overlay = overlay
        self.prepareForward = prepareForward
        self.forward = forward
        self.didDismiss = didDismiss
    }

    enum SendReason: String { case explicit, autoSendImmediate, autoSendDelay, pushToTalk }
    private enum SendState { case ready, sending, failed, accepted }

    private struct Session {
        let token: UUID
        var text: String
        var sendChime: VoiceWakeChime
        var voiceWakeTrigger: String?
        var sendState: SendState = .ready
        var invocation: GatewayAgentInvocation?
    }

    private var session: Session?
    @ObservationIgnored private var sendTask: Task<Void, Never>?

    // MARK: - API

    func startSession(
        text: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        voiceWakeTrigger: String? = nil) -> UUID
    {
        self.retireSession()
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
        guard let session, session.token == token, session.sendState == .ready else { return }
        self.session?.text = text
        self.overlay.updatePartial(token: token, transcript: text, attributed: attributed)
    }

    func updateEditedText(token: UUID, text: String) {
        guard let session, session.token == token,
              session.sendState == .ready || session.sendState == .failed else { return }
        self.session?.text = text
    }

    func finalize(
        token: UUID,
        text: String,
        sendChime: VoiceWakeChime,
        autoSendAfter: TimeInterval?,
        voiceWakeTrigger: String? = nil)
    {
        guard let session, session.token == token, session.sendState == .ready else { return }
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

    @discardableResult
    func sendNow(token: UUID, reason: SendReason = .explicit) -> Task<Void, Never>? {
        guard let session, session.token == token else { return nil }
        switch session.sendState {
        case .sending, .accepted: return nil
        case .failed where reason != .explicit: return nil
        case .ready, .failed: break
        }
        let text = session.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            self.dismiss(token: token, reason: .empty, outcome: .empty)
            return nil
        }

        // Claim before UI callbacks or route lookup can enqueue another send.
        self.session?.sendState = .sending
        self.overlay.beginSendUI(token: token)
        let task = Task { [weak self, prepareForward, forward] in
            guard !Task.isCancelled else { return }
            var invocation = await prepareForward(text, session.voiceWakeTrigger)
            guard let self, !Task.isCancelled, self.session?.token == token else { return }
            if let previous = session.invocation {
                let freshKey = invocation.idempotencyKey
                invocation.idempotencyKey = previous.idempotencyKey
                // A changed transcript, trigger, or resolved delivery route is a new mutation.
                if invocation != previous { invocation.idempotencyKey = freshKey }
            }
            self.session?.invocation = invocation
            let result = await forward(invocation)
            guard !Task.isCancelled, self.session?.token == token else { return }
            self.sendTask = nil
            switch result {
            case .success:
                self.session?.sendState = .accepted
                self.overlay.completeSendUI(token: token, sendChime: session.sendChime)
            case let .failure(error):
                self.session?.sendState = .failed
                self.overlay.failSendUI(token: token, message: error.localizedDescription)
            }
        }
        self.sendTask = task
        return task
    }

    func dismiss(
        token: UUID,
        reason: VoiceWakeOverlayController.DismissReason,
        outcome: VoiceWakeOverlayController.SendOutcome)
    {
        guard self.session?.token == token else { return }
        self.retireSession()
        self.overlay.dismiss(token: token, reason: reason, outcome: outcome)
    }

    /// Retire immediately, not after the dismissal animation: an RPC may settle during it.
    func overlayWillDismiss(token: UUID) {
        guard self.session?.token == token else { return }
        self.retireSession()
    }

    private func retireSession() {
        self.session = nil
        SimpleTaskSupport.stop(task: &self.sendTask)
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
        self.overlayWillDismiss(token: token)
        self.didDismiss(token)
    }
}
