import AppKit
import AVFoundation
import IOKit.hidsystem
import OSLog
import Speech

/// Observes right Option and starts a push-to-talk capture while it is held.
@MainActor
final class VoicePushToTalkHotkey {
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var active = false
    private var enabled = false
    private var talkSuppressed = false

    private let beginAction: @MainActor () -> Void
    private let endAction: @MainActor (_ cancelled: Bool) -> Void

    init(
        beginAction: @escaping @MainActor () -> Void = { VoicePushToTalk.shared.begin() },
        endAction: @escaping @MainActor (Bool) -> Void = { VoicePushToTalk.shared.end(cancelled: $0) })
    {
        self.beginAction = beginAction
        self.endAction = endAction
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        self.reconcile()
    }

    func setTalkSuppressed(_ suppressed: Bool) {
        self.talkSuppressed = suppressed
        self.reconcile()
    }

    private func reconcile() {
        if self.enabled, !self.talkSuppressed, voiceWakeSupported {
            self.startMonitoring()
        } else {
            self.stopMonitoring()
        }
    }

    private func startMonitoring() {
        if ProcessInfo.processInfo.isRunningTests { return }
        guard self.globalMonitor == nil, self.localMonitor == nil else { return }
        // Listen-only global monitor; we rely on Input Monitoring permission to receive events.
        self.globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            let flags = event.modifierFlags
            MainActor.assumeIsolated {
                self?.updateModifierState(modifierFlags: flags)
            }
        }
        // Also listen locally so we still catch events when the app is active/focused.
        self.localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            let flags = event.modifierFlags
            MainActor.assumeIsolated {
                self?.updateModifierState(modifierFlags: flags)
            }
            return event
        }
    }

    private func stopMonitoring() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }
        self.active = false
        // Teardown also cancels a pending start or a released session still draining Speech.
        self.endAction(true)
    }

    private func updateModifierState(modifierFlags: NSEvent.ModifierFlags) {
        guard self.enabled, !self.talkSuppressed else { return }
        // Aggregate Option stays set when the other Option key remains held.
        let chordActive = modifierFlags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0
        if chordActive, !self.active {
            self.active = true
            self.beginAction()
        } else if !chordActive, self.active {
            self.active = false
            self.endAction(false)
        }
    }

    func _testUpdateModifierState(modifierFlags: NSEvent.ModifierFlags) {
        self.updateModifierState(modifierFlags: modifierFlags)
    }
}

/// Records speech while the hotkey is held.
@MainActor
final class VoicePushToTalk {
    static var shared: VoicePushToTalk {
        AppStateStore.shared.voiceRuntime.ptt
    }

    private let state: AppVoiceRuntime.State
    private let wake: VoiceWakeRuntime
    private let sessions: VoiceSessionCoordinator
    private let permissions: VoicePermissions

    init(
        state: @escaping AppVoiceRuntime.State,
        wake: VoiceWakeRuntime,
        sessions: VoiceSessionCoordinator,
        permissions: VoicePermissions)
    {
        self.state = state
        self.wake = wake
        self.sessions = sessions
        self.permissions = permissions
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.ptt")

    private var recognizerCache = SpeechRecognizerCache()
    // Lazily created on begin() to avoid creating an AVAudioEngine at app launch, which can switch Bluetooth
    // headphones into the low-quality headset profile even if push-to-talk is never used.
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var holdID: UUID?
    private var startupTask: Task<Void, Never>?
    private var pauseLease: UUID?

    /// Session token used to drop stale callbacks when a new capture starts.
    private var sessionID = UUID()

    private var committed: String = ""
    private var volatile: String = ""
    private var activeConfig: Config?
    private var isCapturing = false
    private var finalized = true
    private var timeoutTask: Task<Void, Never>?
    private var overlayToken: UUID?
    private var adoptedPrefix: String = ""

    private struct Config {
        let micID: String?
        let localeID: String?
        let triggerChime: VoiceWakeChime
        let sendChime: VoiceWakeChime
    }

    func begin() {
        guard self.permissions.supported(), self.state() != nil, self.holdID == nil else { return }
        let snapshot = self.sessions.snapshot()
        // Retire the old capture, but retain its overlay and wake lease until admission
        // commits or cancels. Dismissing here would animate out the replacement overlay.
        self.retireCapture()
        let sessionID = UUID()
        self.holdID = sessionID
        self.sessionID = sessionID
        self.finalized = false
        self.adoptedPrefix = snapshot.visible ? snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        self.startupTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.holdID == sessionID { self.startupTask = nil }
            }
            let granted = await self.permissions.ensure(true)
            guard !Task.isCancelled, self.holdID == sessionID else { return }
            guard granted, self.sessions.snapshot().token == snapshot.token else {
                self.end(cancelled: true)
                return
            }

            // The startup task owns acquisition until its acknowledgement; end must not remove
            // a lease before the wake actor has inserted it.
            await self.wake.pauseForPushToTalk(lease: sessionID)
            guard !Task.isCancelled, self.holdID == sessionID else {
                await self.wake.resumeAfterPushToTalk(lease: sessionID)
                return
            }
            let previousLease = self.pauseLease
            self.pauseLease = sessionID
            if let previousLease {
                // Acquisition precedes release so wake cannot restart between held sessions.
                Task { [wake] in await wake.resumeAfterPushToTalk(lease: previousLease) }
            }
            guard self.sessions.snapshot().token == snapshot.token else {
                self.end(cancelled: true)
                return
            }
            self.startCapture(sessionID: sessionID)
        }
    }

    private func startCapture(sessionID: UUID) {
        guard let config = self.makeConfig() else {
            self.end(cancelled: true)
            return
        }
        self.activeConfig = config
        self.isCapturing = true
        self.logger.info("ptt begin adopted_prefix_len=\(self.adoptedPrefix.count, privacy: .public)")
        if config.triggerChime != .none {
            VoiceWakeChimePlayer.play(config.triggerChime, reason: "ptt.trigger")
        }
        let adoptedPrefix = self.adoptedPrefix
        let adoptedAttributed: NSAttributedString? = adoptedPrefix.isEmpty ? nil : VoiceOverlayTextFormatting
            .makeAttributed(
                committed: adoptedPrefix,
                volatile: "",
                isFinal: false)
        self.overlayToken = self.sessions.startSession(
            source: .pushToTalk,
            text: adoptedPrefix,
            attributed: adoptedAttributed,
            forwardEnabled: true)

        do {
            try self.startRecognition(localeID: config.localeID, sessionID: sessionID)
        } catch {
            self.logger.debug("push-to-talk failed to start: \(error.localizedDescription, privacy: .public)")
            self.finalize(transcriptOverride: nil, reason: "startFailed", forward: false)
        }
    }

    func end(cancelled: Bool = false) {
        let wasStarting = self.startupTask != nil
        self.holdID = nil
        self.startupTask?.cancel()
        self.startupTask = nil
        if cancelled || wasStarting {
            self.finalize(transcriptOverride: nil, reason: "cancelled", forward: false)
            return
        }
        guard self.isCapturing else { return }
        self.isCapturing = false
        let sessionID = self.sessionID

        // Stop feeding Speech buffers first, then end the request. Stopping the engine here can race with
        // Speech draining its converter chain (and we already stop/cancel in finalize).
        if self.tapInstalled {
            self.audioEngine?.inputNode.removeTap(onBus: 0)
            self.tapInstalled = false
        }
        self.recognitionRequest?.endAudio()

        // If we captured nothing, dismiss immediately when the user lets go.
        if self.committed.isEmpty, self.volatile.isEmpty, self.adoptedPrefix.isEmpty {
            self.finalize(transcriptOverride: "", reason: "emptyOnRelease")
            return
        }

        // Otherwise, give Speech a brief window to deliver the final result; then fall back.
        self.timeoutTask?.cancel()
        self.timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000) // 1.5s grace period to await final result
            } catch {
                return
            }
            guard let self, self.sessionID == sessionID else { return }
            self.finalize(transcriptOverride: nil, reason: "timeout")
        }
    }

    // MARK: - Private

    private func startRecognition(localeID: String?, sessionID: UUID) throws {
        let recognizer = self.recognizerCache.recognizer(localeID: localeID ?? Locale.current.identifier)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoicePushToTalk",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Recognizer unavailable"])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let request = self.recognitionRequest else { return }
        SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)

        // Lazily create the engine here so app launch doesn't grab audio resources / trigger Bluetooth HFP.
        if self.audioEngine == nil {
            self.audioEngine = AVAudioEngine()
        }
        guard let audioEngine = self.audioEngine else { return }

        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.audioEngine = nil
            throw NSError(
                domain: "VoicePushToTalk",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No usable audio input device available"])
        }

        Self.installTap(input: audioEngine.inputNode, request: request)
        self.tapInstalled = true

        audioEngine.prepare()
        try audioEngine.start()

        self.recognitionTask = Self.recognize(recognizer, request: request, owner: self, sessionID: sessionID)
    }

    private nonisolated static func installTap(
        input: AVAudioInputNode,
        request: SFSpeechAudioBufferRecognitionRequest)
    {
        // Construct the callback outside MainActor; PCM delivery must stay on the audio thread.
        input
            .installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { [weak request] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
            }
    }

    private nonisolated static func recognize(
        _ recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest,
        owner: VoicePushToTalk,
        sessionID: UUID) -> SFSpeechRecognitionTask
    {
        recognizer.recognitionTask(with: request) { [weak owner] result, error in
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let message = error?.localizedDescription
            Task { @MainActor [weak owner] in
                if let message {
                    owner?.logger.debug("push-to-talk error: \(message, privacy: .public)")
                }
                owner?.handle(transcript: transcript, isFinal: isFinal, sessionID: sessionID)
            }
        }
    }

    private func handle(transcript: String?, isFinal: Bool, sessionID: UUID) {
        guard !self.finalized, sessionID == self.sessionID else {
            self.logger.debug("push-to-talk drop transcript for stale session")
            return
        }
        guard let transcript else { return }
        if isFinal {
            self.committed = transcript
            self.volatile = ""
        } else {
            self.volatile = VoiceOverlayTextFormatting.delta(after: self.committed, current: transcript)
        }

        let committedWithPrefix = Self.join(self.adoptedPrefix, self.committed)
        let snapshot = Self.join(committedWithPrefix, self.volatile)
        let attributed = VoiceOverlayTextFormatting.makeAttributed(
            committed: committedWithPrefix,
            volatile: self.volatile,
            isFinal: isFinal)
        if let token = self.overlayToken {
            self.sessions.updatePartial(token: token, text: snapshot, attributed: attributed)
        }
    }

    private func finalize(
        transcriptOverride: String?,
        reason: String,
        forward: Bool = true)
    {
        if self.finalized { return }
        self.finalized = true

        let finalRecognized: String = {
            if let override = transcriptOverride?.trimmingCharacters(in: .whitespacesAndNewlines) {
                return override
            }
            return (self.committed + self.volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        }()
        let finalText = Self.join(self.adoptedPrefix, finalRecognized)
        let chime = finalText.isEmpty ? .none : (self.activeConfig?.sendChime ?? .none)

        let token = self.overlayToken
        let lease = self.pauseLease
        self.pauseLease = nil
        self.retireCapture()
        self.overlayToken = nil
        self.adoptedPrefix = ""

        // All old audio and mutable session state are retired before UI callbacks or awaited cleanup.
        self.logger.info("ptt finalize reason=\(reason, privacy: .public) len=\(finalText.count, privacy: .public)")
        if let token {
            if forward {
                self.sessions.finalize(
                    token: token, text: finalText, sendChime: chime, autoSendAfter: nil)
                self.sessions.sendNow(token: token, reason: reason)
            } else {
                self.sessions.dismiss(token: token, reason: .explicit, outcome: .empty)
            }
        }
        if let lease {
            Task { [wake] in await wake.resumeAfterPushToTalk(lease: lease) }
        }
    }

    private func retireCapture() {
        self.isCapturing = false
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.recognitionTask?.cancel()
        self.recognitionRequest = nil
        self.recognitionTask = nil
        if self.tapInstalled {
            self.audioEngine?.inputNode.removeTap(onBus: 0)
            self.tapInstalled = false
        }
        if self.audioEngine?.isRunning == true {
            self.audioEngine?.stop()
            self.audioEngine?.reset()
        }
        // Release the engine so we also release its audio session/resources.
        self.audioEngine = nil
        self.committed = ""
        self.volatile = ""
        self.activeConfig = nil
    }

    @MainActor
    private func makeConfig() -> Config? {
        guard let state = self.state() else { return nil }
        return Config(
            micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
            localeID: state.voiceWakeLocaleID,
            triggerChime: state.voiceWakeTriggerChime,
            sendChime: state.voiceWakeSendChime)
    }

    private static func join(_ prefix: String, _ suffix: String) -> String {
        if prefix.isEmpty { return suffix }
        if suffix.isEmpty { return prefix }
        return "\(prefix) \(suffix)"
    }
}
