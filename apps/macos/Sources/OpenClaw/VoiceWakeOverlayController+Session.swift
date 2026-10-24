import AppKit
import QuartzCore

extension VoiceWakeOverlayController {
    @discardableResult
    func startSession(
        token: UUID = UUID(),
        transcript: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        isFinal: Bool = false) -> UUID
    {
        self.activeToken = token
        SimpleTaskSupport.stop(task: &self.autoSendTask)
        self.setTranscript(transcript, attributed: attributed, isFinal: isFinal, forwardEnabled: forwardEnabled)
        self.lastLevelUpdate = 0
        self.present()
        self.updateWindowFrame(animate: true)
        return token
    }

    func snapshot() -> (token: UUID?, text: String, isVisible: Bool) {
        (self.activeToken, self.model.text, self.model.isVisible)
    }

    func updatePartial(token: UUID, transcript: String, attributed: NSAttributedString? = nil) {
        guard self.guardToken(token) else { return }
        guard !self.model.isFinal else { return }
        SimpleTaskSupport.stop(task: &self.autoSendTask)
        self.setTranscript(transcript, attributed: attributed, isFinal: false, forwardEnabled: false)
        self.present()
        self.updateWindowFrame(animate: true)
    }

    func presentFinal(
        token: UUID,
        transcript: String,
        autoSendAfter delay: TimeInterval?,
        attributed: NSAttributedString? = nil)
    {
        guard self.guardToken(token) else { return }
        self.autoSendTask?.cancel()
        self.setTranscript(
            transcript,
            attributed: attributed,
            isFinal: true,
            forwardEnabled: !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        self.present()
        if let delay {
            if delay <= 0 {
                self.actions()?.send(token)
            } else {
                self.scheduleAutoSend(token: token, after: delay)
            }
        }
    }

    private func setTranscript(
        _ transcript: String,
        attributed: NSAttributedString?,
        isFinal: Bool,
        forwardEnabled: Bool)
    {
        self.model.text = transcript
        self.model.isFinal = isFinal
        self.model.forwardEnabled = forwardEnabled
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
    }

    func userBeganEditing() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = true
    }

    func cancelEditingAndDismiss() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false
        self.dismiss(reason: .explicit)
    }

    func endEditing() {
        self.model.isEditing = false
    }

    func updateText(_ text: String) {
        if let token = self.activeToken {
            self.actions()?.updateEditedText(token, text)
        }
        self.model.text = text
        self.model.isSending = false
        self.model.attributed = self.makeAttributed(from: text)
        self.updateWindowFrame(animate: true)
    }

    /// UI-only path: show sending state and dismiss; actual forwarding is handled by the coordinator.
    func beginSendUI(token: UUID, sendChime: VoiceWakeChime = .none) {
        guard self.guardToken(token) else { return }
        self.autoSendTask?.cancel()
        if self.model.isSending { return }
        self.model.isEditing = false

        if sendChime != .none {
            VoiceWakeChimePlayer.play(sendChime)
        }

        self.model.isSending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.dismiss(token: token, reason: .explicit, outcome: .sent)
        }
    }

    func requestSend(token: UUID? = nil) {
        guard self.guardToken(token) else { return }
        guard let active = token ?? self.activeToken else { return }
        self.actions()?.send(active)
    }

    func dismiss(token: UUID? = nil, reason: DismissReason = .explicit, outcome: SendOutcome = .empty) {
        guard self.guardToken(token) else { return }
        guard let dismissedToken = self.activeToken else { return }
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false

        // Retain the admitted notification owner through the animation. Resolving it
        // later could lose cleanup when the graph is no longer available.
        let actions = self.actions()
        self.presentation.animateDismiss(self, reason, outcome) { completion in
            switch completion {
            case .disabledUI:
                self.clearDismissedSession()
            case .missingWindow:
                if ProcessInfo.processInfo.isRunningTests {
                    self.clearDismissedSession(resetLevelUpdate: false)
                }
            case let .animated(finishWindow):
                guard self.guardToken(dismissedToken) else { return }
                finishWindow()
                self.clearDismissedSession()
                actions?.didDismiss(dismissedToken, outcome)
            }
        }
    }

    private func clearDismissedSession(resetLevelUpdate: Bool = true) {
        self.model.isVisible = false
        self.model.level = 0
        if resetLevelUpdate { self.lastLevelUpdate = 0 }
        self.activeToken = nil
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard self.guardToken(token) else { return }
        guard self.model.isVisible else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if level != 0, now - self.lastLevelUpdate < self.levelUpdateInterval {
            return
        }
        self.lastLevelUpdate = now
        self.model.level = max(0, min(1, level))
    }

    private func guardToken(_ token: UUID?) -> Bool {
        switch Self.evaluateToken(active: self.activeToken, incoming: token) {
        case .accept:
            true
        case .dropMismatch, .dropNoActive:
            false
        }
    }

    nonisolated static func evaluateToken(active: UUID?, incoming: UUID?) -> GuardOutcome {
        guard let active else { return .dropNoActive }
        if let incoming, incoming != active { return .dropMismatch }
        return .accept
    }

    func scheduleAutoSend(token: UUID, after delay: TimeInterval) {
        SimpleTaskSupport.schedule(task: &self.autoSendTask, delay: max(0, delay)) { [weak self] in
            guard let self, self.guardToken(token) else { return }
            self.actions()?.send(token)
            self.autoSendTask = nil
        }
    }

    func makeAttributed(from text: String) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            ])
    }
}
