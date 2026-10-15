import AppKit
import QuartzCore

extension VoiceWakeOverlayController {
    @discardableResult
    func startSession(
        token: UUID = UUID(),
        source: VoiceSessionCoordinator.Source,
        transcript: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        isFinal: Bool = false) -> UUID
    {
        let message = """
        overlay session_start source=\(source.rawValue) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
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
        guard self.guardToken(token, context: "partial") else { return }
        guard !self.model.isFinal else { return }
        let message = """
        overlay partial token=\(token.uuidString) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
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
        guard self.guardToken(token, context: "final") else { return }
        let message = """
        overlay presentFinal token=\(token.uuidString) \
        len=\(transcript.count) \
        autoSendAfter=\(delay ?? -1) \
        forwardEnabled=\(!transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel()
        self.setTranscript(
            transcript,
            attributed: attributed,
            isFinal: true,
            forwardEnabled: !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        self.present()
        if let delay {
            if delay <= 0 {
                self.logger.log(level: .info, "overlay autoSend immediate token=\(token.uuidString)")
                self.actions()?.send(token, "autoSendImmediate")
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
        guard self.guardToken(token, context: "beginSendUI") else { return }
        self.autoSendTask?.cancel()
        let message = """
        overlay beginSendUI token=\(token.uuidString) \
        isSending=\(self.model.isSending) \
        forwardEnabled=\(self.model.forwardEnabled) \
        textLen=\(self.model.text.count)
        """
        self.logger.log(level: .info, "\(message)")
        if self.model.isSending { return }
        self.model.isEditing = false

        if sendChime != .none {
            let message = "overlay beginSendUI playing sendChime=\(String(describing: sendChime))"
            self.logger.log(level: .info, "\(message)")
            VoiceWakeChimePlayer.play(sendChime, reason: "overlay.send")
        }

        self.model.isSending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.logger.log(
                level: .info,
                "overlay beginSendUI dismiss ticking token=\(self.activeToken?.uuidString ?? "nil")")
            self.dismiss(token: token, reason: .explicit, outcome: .sent)
        }
    }

    func requestSend(token: UUID? = nil, reason: String = "overlay_request") {
        guard self.guardToken(token, context: "requestSend") else { return }
        guard let active = token ?? self.activeToken else { return }
        self.actions()?.send(active, reason)
    }

    func dismiss(token: UUID? = nil, reason: DismissReason = .explicit, outcome: SendOutcome = .empty) {
        guard self.guardToken(token, context: "dismiss") else { return }
        guard let dismissedToken = self.activeToken else { return }
        let message = """
        overlay dismiss token=\(self.activeToken?.uuidString ?? "nil") \
        reason=\(String(describing: reason)) \
        outcome=\(String(describing: outcome)) \
        visible=\(self.model.isVisible) \
        sending=\(self.model.isSending)
        """
        self.logger.log(level: .info, "\(message)")
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
                guard self.guardToken(dismissedToken, context: "dismissCompletion") else { return }
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
        guard self.guardToken(token, context: "level") else { return }
        guard self.model.isVisible else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if level != 0, now - self.lastLevelUpdate < self.levelUpdateInterval {
            return
        }
        self.lastLevelUpdate = now
        self.model.level = max(0, min(1, level))
    }

    private func guardToken(_ token: UUID?, context: String) -> Bool {
        switch Self.evaluateToken(active: self.activeToken, incoming: token) {
        case .accept:
            return true
        case .dropMismatch:
            self.logger.log(
                level: .info,
                """
                overlay drop \(context, privacy: .public) token_mismatch \
                active=\(self.activeToken?.uuidString ?? "nil", privacy: .public) \
                got=\(token?.uuidString ?? "nil", privacy: .public)
                """)
            return false
        case .dropNoActive:
            self.logger.log(level: .info, "overlay drop \(context, privacy: .public) no_active")
            return false
        }
    }

    nonisolated static func evaluateToken(active: UUID?, incoming: UUID?) -> GuardOutcome {
        guard let active else { return .dropNoActive }
        if let incoming, incoming != active { return .dropMismatch }
        return .accept
    }

    func scheduleAutoSend(token: UUID, after delay: TimeInterval) {
        self.logger.log(
            level: .info,
            """
            overlay scheduleAutoSend token=\(token.uuidString) \
            after=\(delay)
            """)
        SimpleTaskSupport.schedule(task: &self.autoSendTask, delay: max(0, delay)) { [weak self] in
            guard let self, self.guardToken(token, context: "autoSend") else { return }
            self.logger.log(level: .info, "overlay autoSend firing token=\(token.uuidString, privacy: .public)")
            self.actions()?.send(token, "autoSendDelay")
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
