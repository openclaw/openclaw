import AVFoundation
import Foundation
import OpenClawKit
import OSLog
import Speech
import SwabbleKit
#if canImport(AppKit)
    import AppKit
#endif

actor VoiceWakeRuntime {
    private let state: AppVoiceRuntime.State
    private let sessions: VoiceSessionCoordinator
    private let overlay: VoiceWakeOverlayController
    private let permissions: VoicePermissions
    private let forward: AppVoiceRuntime.Forward

    init(
        state: @escaping AppVoiceRuntime.State,
        sessions: VoiceSessionCoordinator,
        overlay: VoiceWakeOverlayController,
        permissions: VoicePermissions,
        forward: @escaping AppVoiceRuntime.Forward
    ) {
        self.state = state
        self.sessions = sessions
        self.overlay = overlay
        self.permissions = permissions
        self.forward = forward
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.runtime")

    private var recognizerCache = SpeechRecognizerCache()
    // Lazily created on start to avoid creating an AVAudioEngine at app launch, which can switch Bluetooth
    // headphones into the low-quality headset profile even if Voice Wake is disabled.
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: Int = 0 // drop stale callbacks after restarts
    private var lastHeard: Date?
    private var noiseFloorRMS: Double = 1e-4
    private var captureStartedAt: Date?
    private var captureTask: Task<Void, Never>?
    private var capturedTranscript: String = ""
    private var isCapturing: Bool = false
    private var heardBeyondTrigger: Bool = false
    private var committedTranscript: String = ""
    private var volatileTranscript: String = ""
    private var cooldownUntil: Date?
    private var currentConfig: RuntimeConfig?
    private var overlayToken: UUID?
    private var activeTriggerEndTime: TimeInterval?
    private var activeTriggerWord: String?
    private var scheduledRestartTask: Task<Void, Never>?
    private var lastLoggedText: String?
    private var lastLoggedAt: Date?
    private var lastTapLogAt: Date?
    private var lastCallbackLogAt: Date?
    private var lastTranscript: String?
    private var lastTranscriptAt: Date?
    private var pauseCheckTask: Task<Void, Never>?
    private var pauseLeases: Set<UUID> = []
    private var refreshGeneration: UInt64 = 0
    private var diagnostic: Diagnostic?

    private struct Diagnostic {
        let id: UUID
        var update: (@MainActor @Sendable (VoiceWakeTestState) -> Void)?
    }

    /// Silence threshold once we've captured user speech (post-trigger).
    private let silenceWindow: TimeInterval = 2.0
    /// Silence threshold when we only heard the trigger but no post-trigger speech yet.
    private let triggerOnlySilenceWindow: TimeInterval = 5.0
    // Maximum capture duration from trigger until we force-send, to avoid runaway sessions.
    private let captureHardStop: TimeInterval = 120.0
    private let debounceAfterSend: TimeInterval = 0.35
    // Voice activity detection parameters (RMS-based).
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0 // how far above noise floor we require to mark speech
    private let preDetectSilenceWindow: TimeInterval = 1.0
    private let triggerPauseWindow: TimeInterval = 0.55

    /// Stops the active Speech pipeline without clearing the stored config, so we can restart cleanly.
    private func haltRecognitionPipeline() {
        // Bump generation first so any in-flight callbacks from the cancelled task get dropped.
        recognitionGeneration &+= 1
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        // Release the engine so we also release any audio session/resources when Voice Wake is idle.
        audioEngine = nil
    }

    struct RuntimeConfig: Equatable {
        let triggers: [String]
        let micID: String?
        let localeID: String?
        let triggerChime: VoiceWakeChime
        let sendChime: VoiceWakeChime
        let triggersTalkMode: Bool
    }

    private struct RecognitionUpdate {
        let transcript: String?
        let segments: [WakeWordSegment]
        let isFinal: Bool
        let error: Error?
        let generation: Int
    }

    func refresh(state: AppState) async {
        refreshGeneration &+= 1
        let generation = refreshGeneration
        let snapshot = await MainActor.run { () -> (Bool, RuntimeConfig) in
            let enabled = state.swabbleEnabled
            let config = RuntimeConfig(
                triggers: sanitizeVoiceWakeTriggers(state.swabbleTriggerWords),
                micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
                localeID: state.voiceWakeLocaleID.isEmpty ? nil : state.voiceWakeLocaleID,
                triggerChime: state.voiceWakeTriggerChime,
                sendChime: state.voiceWakeSendChime,
                triggersTalkMode: state.voiceWakeTriggersTalkMode
            )
            return (enabled, config)
        }
        guard generation == refreshGeneration, pauseLeases.isEmpty, diagnostic == nil else { return }

        guard permissions.supported(), snapshot.0 else {
            stop()
            return
        }

        guard permissions.granted() else {
            logger.debug("voicewake runtime not starting: permissions missing")
            stop()
            return
        }

        let config = snapshot.1

        if scheduledRestartTask != nil, config == currentConfig, recognitionTask == nil {
            return
        }

        SimpleTaskSupport.stop(task: &scheduledRestartTask)

        if config == currentConfig, recognitionTask != nil {
            return
        }

        stop()
        start(with: config)
    }

    private func start(with config: RuntimeConfig) {
        // Scheduled restarts also enter here, without passing through refresh.
        guard pauseLeases.isEmpty else { return }
        do {
            recognitionGeneration &+= 1
            let generation = recognitionGeneration

            let recognizer = recognizerCache.recognizer(localeID: config.localeID ?? Locale.current.identifier)

            guard let recognizer, recognizer.isAvailable else {
                throw NSError(domain: "VoiceWakeRuntime", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognition unavailable",
                ])
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            recognitionRequest = request
            try SpeechRecognitionRequestPolicy.configurePassiveVoiceWake(
                request,
                supportsOnDeviceRecognition: recognizer.supportsOnDeviceRecognition
            )

            // Lazily create the engine here so app launch doesn't grab audio resources / trigger Bluetooth HFP.
            let audioEngine = self.audioEngine ?? AVAudioEngine()
            self.audioEngine = audioEngine

            guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
                self.audioEngine = nil
                throw NSError(
                    domain: "VoiceWakeRuntime",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No usable audio input device available"]
                )
            }

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                throw NSError(
                    domain: "VoiceWakeRuntime",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No audio input available"]
                )
            }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, weak request] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
                let rms = TalkAudioLevel.rms(buffer: buffer)
                Task.detached { [weak self] in
                    await self?.noteAudioLevel(rms: rms)
                    await self?.noteAudioTap(rms: rms)
                }
            }

            audioEngine.prepare()
            try audioEngine.start()

            currentConfig = config
            lastHeard = Date()
            // Preserve any existing cooldownUntil so the debounce after send isn't wiped by a restart.

            recognitionTask = recognizer.recognitionTask(with: request) { [weak self, generation] result, error in
                guard let self else { return }
                let transcript = result?.bestTranscription.formattedString
                let segments = result.flatMap { result in
                    transcript
                        .map { WakeWordSpeechSegments.from(transcription: result.bestTranscription, transcript: $0) }
                } ?? []
                let isFinal = result?.isFinal ?? false
                Task { await self.noteRecognitionCallback(transcript: transcript, isFinal: isFinal, error: error) }
                let update = RecognitionUpdate(
                    transcript: transcript,
                    segments: segments,
                    isFinal: isFinal,
                    error: error,
                    generation: generation
                )
                Task { await self.handleRecognition(update, config: config) }
            }

            let preferred = config.micID ?? "system-default"
            logger.info(
                "voicewake runtime input preferred=\(preferred, privacy: .public) " +
                    "\(AudioInputDeviceObserver.defaultInputDeviceSummary(), privacy: .public)"
            )
            logger.info("voicewake runtime started")
            updateDiagnostic(.listening)
            DiagnosticsFileLog.shared.log(category: "voicewake.runtime", event: "started", fields: [
                "locale": config.localeID ?? "",
                "micID": config.micID ?? "",
            ])
        } catch {
            logger.error("voicewake runtime failed to start: \(error.localizedDescription, privacy: .public)")
            if diagnostic != nil {
                finishDiagnostic(.failed(error.localizedDescription))
            } else {
                stop()
            }
        }
    }

    func startDiagnostic(
        id: UUID,
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @MainActor @Sendable (VoiceWakeTestState) -> Void
    ) async throws {
        try Task.checkCancellation()
        guard diagnostic == nil, pauseLeases.isEmpty, !isCapturing else {
            throw NSError(domain: "VoiceWakeRuntime", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Microphone is in use",
            ])
        }
        refreshGeneration &+= 1
        stop(dismissOverlay: false)
        diagnostic = Diagnostic(id: id, update: onUpdate)
        do {
            let recognizer = recognizerCache.recognizer(localeID: localeID ?? Locale.current.identifier)
            guard let recognizer, recognizer.isAvailable else {
                throw NSError(domain: "VoiceWakeRuntime", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognition unavailable",
                ])
            }
            guard recognizer.supportsOnDeviceRecognition else {
                throw SpeechRecognitionRequestPolicy.PolicyError.onDeviceRecognitionUnavailable
            }
            let privacyKeys = ["NSSpeechRecognitionUsageDescription", "NSMicrophoneUsageDescription"]
            guard privacyKeys
                .allSatisfy({ (Bundle.main.object(forInfoDictionaryKey: $0) as? String)?.isEmpty == false })
            else {
                throw NSError(domain: "VoiceWakeRuntime", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: """
                    Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) \
                    to include usage descriptions.
                    """,
                ])
            }
            let granted = try await ensureDiagnosticPermissions(id: id)
            try Task.checkCancellation()
            guard diagnostic?.id == id, diagnostic?.update != nil, pauseLeases.isEmpty else {
                throw CancellationError()
            }
            guard granted else {
                throw NSError(domain: "VoiceWakeRuntime", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Microphone or speech permission denied",
                ])
            }
            start(with: RuntimeConfig(
                triggers: triggers,
                micID: micID,
                localeID: localeID,
                triggerChime: .none,
                sendChime: .none,
                triggersTalkMode: false
            ))
        } catch {
            await stopDiagnostic(id: id)
            throw error
        }
    }

    func finalizeDiagnostic(id: UUID) {
        guard diagnostic?.id == id, diagnostic?.update != nil else { return }
        recognitionRequest?.endAudio()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        updateDiagnostic(.finalizing)
        captureTask = Task { [weak self] in
            guard await SimpleTaskSupport.waitForNextOperation(interval: 1.5) else { return }
            guard let self, self.diagnostic?.id == id else { return }
            self.stop(dismissOverlay: false)
            self.diagnostic?.update = nil
        }
    }

    func stopDiagnostic(id: UUID) async {
        guard diagnostic?.id == id else { return }
        diagnostic = nil
        stop(dismissOverlay: false)
        if let state = await state() {
            await refresh(state: state)
        }
    }

    private func updateDiagnostic(_ state: VoiceWakeTestState) {
        guard let update = diagnostic?.update else { return }
        Task { @MainActor in update(state) }
    }

    private func finishDiagnostic(_ state: VoiceWakeTestState) {
        guard diagnostic?.update != nil else { return }
        stop(dismissOverlay: false)
        updateDiagnostic(state)
        diagnostic?.update = nil
    }

    private func ensureDiagnosticPermissions(id: UUID) async throws -> Bool {
        guard AppLaunchRuntimePlan.current.allowsActivation else {
            let granted = PermissionManager.voiceWakePermissionsGranted()
            if !granted {
                PermissionManager.reportDeferredRequest()
            }
            return granted
        }
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
            guard granted else { return false }
        } else if speechStatus != .authorized {
            return false
        }
        try Task.checkCancellation()
        guard diagnostic?.id == id, diagnostic?.update != nil, pauseLeases.isEmpty else {
            throw CancellationError()
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    private func stop(dismissOverlay: Bool = true) {
        SimpleTaskSupport.stop(task: &scheduledRestartTask)
        SimpleTaskSupport.stop(task: &captureTask)
        isCapturing = false
        capturedTranscript = ""
        captureStartedAt = nil
        lastTranscript = nil
        lastTranscriptAt = nil
        SimpleTaskSupport.stop(task: &pauseCheckTask)
        haltRecognitionPipeline()
        currentConfig = nil
        activeTriggerEndTime = nil
        activeTriggerWord = nil
        logger.debug("voicewake runtime stopped")
        DiagnosticsFileLog.shared.log(category: "voicewake.runtime", event: "stopped")

        let token = overlayToken
        overlayToken = nil
        guard dismissOverlay else { return }
        Task { @MainActor [sessions, overlay] in
            if let token {
                sessions.dismiss(token: token, reason: .explicit, outcome: .empty)
            } else {
                overlay.dismiss()
            }
        }
    }

    private func handleRecognition(_ update: RecognitionUpdate, config: RuntimeConfig) async {
        if update.generation != recognitionGeneration {
            return // stale callback from a superseded recognizer session
        }
        if let error = update.error {
            logger.debug("voicewake recognition error: \(error.localizedDescription, privacy: .public)")
        }

        guard update.transcript != nil || diagnostic != nil else { return }
        let transcript = update.transcript ?? ""

        let now = Date()
        if !transcript.isEmpty {
            lastHeard = now
            if !isCapturing {
                lastTranscript = transcript
                lastTranscriptAt = now
            }
            if isCapturing {
                maybeLogRecognition(
                    transcript: transcript,
                    segments: update.segments,
                    triggers: config.triggers,
                    isFinal: update.isFinal,
                    match: nil,
                    usedFallback: false,
                    capturing: true
                )
                let trimmed = Self.commandAfterTrigger(
                    transcript: transcript,
                    segments: update.segments,
                    triggerEndTime: activeTriggerEndTime,
                    triggers: config.triggers
                )
                capturedTranscript = trimmed
                if !trimmed.isEmpty {
                    heardBeyondTrigger = true
                }
                if update.isFinal {
                    committedTranscript = trimmed
                    volatileTranscript = ""
                } else {
                    volatileTranscript = VoiceOverlayTextFormatting.delta(
                        after: committedTranscript,
                        current: trimmed
                    )
                }

                let attributed = VoiceOverlayTextFormatting.makeAttributed(
                    committed: committedTranscript,
                    volatile: volatileTranscript,
                    isFinal: update.isFinal
                )
                let snapshot = committedTranscript + volatileTranscript
                if let token = overlayToken {
                    await MainActor.run {
                        self.sessions.updatePartial(
                            token: token,
                            text: snapshot,
                            attributed: attributed
                        )
                    }
                }
            }
        }

        if isCapturing {
            return
        }

        let gateConfig = WakeWordGateConfig(triggers: config.triggers)
        var usedFallback = false
        var match = WakeWordGate.match(transcript: transcript, segments: update.segments, config: gateConfig)
        if match == nil, update.isFinal {
            match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
                transcript: transcript,
                triggers: config.triggers,
                config: gateConfig,
                trimWake: diagnostic == nil ? Self.trimmedAfterTrigger : WakeWordGate.stripWake
            )
            usedFallback = match != nil
        }
        maybeLogRecognition(
            transcript: transcript,
            segments: update.segments,
            triggers: config.triggers,
            isFinal: update.isFinal,
            match: match,
            usedFallback: usedFallback,
            capturing: false
        )

        if diagnostic != nil {
            let triggerOnlyMatch = match == nil
                ? VoiceWakeRecognitionDebugSupport.triggerOnlyFallbackMatch(
                    transcript: transcript, triggers: config.triggers, trimWake: WakeWordGate.stripWake
                )
                : nil
            match = match.flatMap { $0.command.isEmpty ? nil : $0 } ?? triggerOnlyMatch
            if let match {
                finishDiagnostic(.detected(match.command.isEmpty ? (match.trigger ?? transcript) : match.command))
            } else if let error = update.error {
                finishDiagnostic(.failed(error.localizedDescription))
            } else if update.isFinal {
                finishDiagnostic(.failed(transcript
                        .isEmpty ? "No speech detected" : "No trigger heard: “\(transcript)”"))
            } else {
                updateDiagnostic(transcript.isEmpty ? .listening : .hearing(transcript))
                if !transcript.isEmpty {
                    schedulePauseCheck(triggerOnly: false, config: config)
                }
            }
            return
        }

        if let match {
            if let cooldown = cooldownUntil, now < cooldown {
                return
            }
            if usedFallback {
                logger.info("voicewake runtime detected (text-only fallback) len=\(match.command.count)")
            } else {
                logger.info("voicewake runtime detected len=\(match.command.count)")
            }
            await beginCapture(
                command: match.command,
                triggerEndTime: match.triggerEndTime,
                triggerWord: match.trigger,
                config: config
            )
        } else if !transcript.isEmpty, update.error == nil {
            schedulePauseCheck(
                triggerOnly: Self.isTriggerOnlyText(transcript: transcript, triggers: config.triggers),
                config: config
            )
        }
    }

    private func maybeLogRecognition(
        transcript: String,
        segments: [WakeWordSegment],
        triggers: [String],
        isFinal: Bool,
        match: WakeWordGateMatch?,
        usedFallback: Bool,
        capturing: Bool
    ) {
        guard VoiceWakeRecognitionDebugSupport.shouldLogTranscript(
            transcript: transcript,
            isFinal: isFinal,
            loggerLevel: logger.logLevel,
            lastLoggedText: &lastLoggedText,
            lastLoggedAt: &lastLoggedAt
        )
        else { return }

        let summary = VoiceWakeRecognitionDebugSupport.transcriptSummary(
            transcript: transcript,
            triggers: triggers,
            segments: segments
        )
        let matchSummary = VoiceWakeRecognitionDebugSupport.matchSummary(match)

        logger.debug(
            "voicewake runtime transcript='\(transcript, privacy: .private)' textOnly=\(summary.textOnly) " +
                "isFinal=\(isFinal) timing=\(summary.timingCount)/\(segments.count) " +
                "capturing=\(capturing) fallback=\(usedFallback) " +
                "\(matchSummary) " +
                "segments=[\(VoiceWakeRecognitionDebugSupport.segmentSummary(segments), privacy: .private)]"
        )
    }

    private func noteAudioTap(rms: Double) {
        let now = Date()
        if let last = lastTapLogAt, now.timeIntervalSince(last) < 1.0 {
            return
        }
        lastTapLogAt = now
        let db = 20 * log10(max(rms, 1e-7))
        logger.debug(
            "voicewake runtime audio tap rms=\(String(format: "%.6f", rms)) " +
                "db=\(String(format: "%.1f", db)) capturing=\(isCapturing)"
        )
    }

    private func noteRecognitionCallback(transcript: String?, isFinal: Bool, error: Error?) {
        guard transcript?.isEmpty ?? true else { return }
        let now = Date()
        if let last = lastCallbackLogAt, now.timeIntervalSince(last) < 1.0 {
            return
        }
        lastCallbackLogAt = now
        let errorSummary = error?.localizedDescription ?? "none"
        logger.debug(
            "voicewake runtime callback empty transcript isFinal=\(isFinal) error=\(errorSummary, privacy: .public)"
        )
    }

    private func schedulePauseCheck(triggerOnly: Bool, config: RuntimeConfig) {
        pauseCheckTask?.cancel()
        let lastSeenAt = lastTranscriptAt
        let lastText = lastTranscript
        let window = triggerOnly ? triggerPauseWindow : preDetectSilenceWindow
        pauseCheckTask = Task { [weak self] in
            guard await SimpleTaskSupport.waitForNextOperation(interval: window) else { return }
            await self?.checkPause(
                lastSeenAt: lastSeenAt,
                lastText: lastText,
                triggerOnly: triggerOnly,
                config: config
            )
        }
    }

    private func checkPause(
        lastSeenAt: Date?,
        lastText: String?,
        triggerOnly: Bool,
        config: RuntimeConfig
    ) async {
        guard !Task.isCancelled, !isCapturing,
              let lastSeenAt, let lastText,
              lastTranscriptAt == lastSeenAt, lastTranscript == lastText
        else { return }
        let command: String
        let triggerEndTime: TimeInterval?
        let triggerWord: String?
        if triggerOnly {
            guard Self.isTriggerOnlyText(transcript: lastText, triggers: config.triggers) else { return }
            command = ""
            triggerEndTime = nil
            triggerWord = VoiceWakeTextUtils.matchedTriggerWord(transcript: lastText, triggers: config.triggers)
        } else {
            guard let match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
                transcript: lastText,
                triggers: config.triggers,
                config: WakeWordGateConfig(triggers: config.triggers),
                trimWake: diagnostic == nil ? Self.trimmedAfterTrigger : WakeWordGate.stripWake
            )
            else { return }
            command = match.command
            triggerEndTime = match.triggerEndTime
            triggerWord = match.trigger
        }
        if diagnostic != nil {
            finishDiagnostic(.detected(command.isEmpty ? (triggerWord ?? lastText) : command))
            return
        }
        if let cooldown = cooldownUntil, Date() < cooldown {
            return
        }
        if triggerOnly {
            logger.info("voicewake runtime detected (trigger-only pause)")
        } else {
            logger.info("voicewake runtime detected (silence fallback) len=\(command.count)")
        }
        await beginCapture(
            command: command,
            triggerEndTime: triggerEndTime,
            triggerWord: triggerWord,
            config: config
        )
    }

    static func isTriggerOnlyText(transcript: String, triggers: [String]) -> Bool {
        VoiceWakeTextUtils.isTriggerOnly(
            transcript: transcript,
            triggers: triggers,
            trimWake: trimmedAfterTrigger
        )
    }

    private func beginCapture(
        command: String,
        triggerEndTime: TimeInterval?,
        triggerWord: String?,
        config: RuntimeConfig
    ) async {
        // When "Trigger Talk Mode" is enabled, skip the capture/overlay flow entirely
        // and activate Talk Mode immediately. Talk Mode handles its own STT pipeline.
        // Pause the wake listener to avoid two audio pipelines competing on the mic
        // (mirrors the push-to-talk coordination pattern).
        if config.triggersTalkMode {
            logger.info("voicewake trigger -> activating Talk Mode (skipping capture)")
            DiagnosticsFileLog.shared.log(category: "voicewake.runtime", event: "triggerTalkMode")
            let lease = UUID()
            pauseForPushToTalk(lease: lease)
            if config.triggerChime != .none {
                await MainActor.run { VoiceWakeChimePlayer.play(config.triggerChime, reason: "voicewake.trigger") }
            }
            await state()?.setTalkEnabled(true)
            await resumeAfterPushToTalk(lease: lease)
            return
        }
        isCapturing = true
        DiagnosticsFileLog.shared.log(category: "voicewake.runtime", event: "beginCapture")
        capturedTranscript = command
        committedTranscript = ""
        volatileTranscript = command
        captureStartedAt = Date()
        cooldownUntil = nil
        heardBeyondTrigger = !command.isEmpty
        activeTriggerEndTime = triggerEndTime
        activeTriggerWord = triggerWord
        SimpleTaskSupport.stop(task: &pauseCheckTask)

        if config.triggerChime != .none {
            await MainActor.run { VoiceWakeChimePlayer.play(config.triggerChime, reason: "voicewake.trigger") }
        }

        let snapshot = committedTranscript + volatileTranscript
        let attributed = VoiceOverlayTextFormatting.makeAttributed(
            committed: committedTranscript,
            volatile: volatileTranscript,
            isFinal: false
        )
        overlayToken = await MainActor.run {
            guard self.state() != nil else { return nil as UUID? }
            return self.sessions.startSession(
                source: .wakeWord,
                text: snapshot,
                attributed: attributed,
                forwardEnabled: true,
                voiceWakeTrigger: triggerWord
            )
        }

        // Keep the "ears" boosted for the capture window so the status icon animates while recording.
        await MainActor.run { self.state()?.earBoostActive = true }

        captureTask?.cancel()
        captureTask = Task { [weak self] in
            await self?.monitorCapture(config: config)
        }
    }

    private func monitorCapture(config: RuntimeConfig) async {
        let start = captureStartedAt ?? Date()
        let hardStop = start.addingTimeInterval(captureHardStop)

        while isCapturing {
            let now = Date()
            if now >= hardStop {
                // Hard-stop after a maximum duration so we never leave the recognizer pinned open.
                await finalizeCapture(config: config)
                return
            }

            let silenceThreshold = heardBeyondTrigger ? silenceWindow : triggerOnlySilenceWindow
            if let last = lastHeard, now.timeIntervalSince(last) >= silenceThreshold {
                await finalizeCapture(config: config)
                return
            }

            guard await SimpleTaskSupport.waitForNextOperation(interval: 0.2) else { return }
        }
    }

    private func finalizeCapture(config: RuntimeConfig) async {
        guard isCapturing else { return }
        isCapturing = false
        // Disarm trigger matching immediately (before halting recognition) to avoid double-trigger
        // races from late callbacks that arrive after isCapturing is cleared.
        cooldownUntil = Date().addingTimeInterval(debounceAfterSend)
        SimpleTaskSupport.stop(task: &captureTask)

        let finalTranscript = capturedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        DiagnosticsFileLog.shared.log(category: "voicewake.runtime", event: "finalizeCapture", fields: [
            "finalLen": "\(finalTranscript.count)",
        ])
        // Stop further recognition events so we don't retrigger immediately with buffered audio.
        haltRecognitionPipeline()
        capturedTranscript = ""
        captureStartedAt = nil
        lastHeard = nil
        heardBeyondTrigger = false
        let triggerWord = activeTriggerWord
        activeTriggerEndTime = nil
        activeTriggerWord = nil
        lastTranscript = nil
        lastTranscriptAt = nil
        SimpleTaskSupport.stop(task: &pauseCheckTask)

        await MainActor.run { self.state()?.earBoostActive = false }
        if let token = overlayToken {
            await MainActor.run { self.sessions.updateLevel(token: token, 0) }
        }

        let sendChime = finalTranscript.isEmpty ? .none : config.sendChime
        if let token = overlayToken {
            await MainActor.run {
                self.sessions.finalize(
                    token: token,
                    text: finalTranscript,
                    sendChime: sendChime,
                    autoSendAfter: 0,
                    voiceWakeTrigger: triggerWord
                )
            }
        } else if !finalTranscript.isEmpty {
            if sendChime != .none {
                await MainActor.run { VoiceWakeChimePlayer.play(sendChime, reason: "voicewake.send") }
            }
            Task.detached { [forward] in
                await forward(finalTranscript, triggerWord)
            }
        }
        overlayToken = nil
        scheduleRestartRecognizer()
    }

    // MARK: - Audio level handling

    private func noteAudioLevel(rms: Double) {
        guard isCapturing else { return }

        // Update adaptive noise floor: faster when lower energy (quiet), slower when loud.
        let alpha: Double = rms < noiseFloorRMS ? 0.08 : 0.01
        noiseFloorRMS = max(1e-7, noiseFloorRMS + (rms - noiseFloorRMS) * alpha)

        let threshold = max(minSpeechRMS, noiseFloorRMS * speechBoostFactor)
        if rms >= threshold {
            lastHeard = Date()
        }

        // Normalize against the adaptive threshold so the UI meter stays roughly 0...1 across devices.
        let clamped = min(1.0, max(0.0, rms / max(minSpeechRMS, threshold)))
        if let token = overlayToken {
            Task { @MainActor [sessions] in
                sessions.updateLevel(token: token, clamped)
            }
        }
    }

    private func restartRecognizer() {
        // Restart the recognizer so we listen for the next trigger with a clean buffer.
        let current = currentConfig
        stop(dismissOverlay: false)
        if let current {
            start(with: current)
        }
    }

    private func restartRecognizerIfIdleAndOverlayHidden() {
        guard !Task.isCancelled, pauseLeases.isEmpty, !isCapturing else { return }
        scheduledRestartTask = nil
        restartRecognizer()
    }

    private func scheduleRestartRecognizer() {
        scheduledRestartTask?.cancel()
        scheduledRestartTask = Task { [weak self] in
            guard await SimpleTaskSupport.waitForNextOperation(interval: 0.7) else { return }
            guard let self else { return }
            await self.restartRecognizerIfIdleAndOverlayHidden()
        }
    }

    func pauseForPushToTalk(lease: UUID) {
        guard pauseLeases.insert(lease).inserted else { return }
        refreshGeneration &+= 1
        finishDiagnostic(.failed(String(localized: "Stopped")))
        stop(dismissOverlay: false)
    }

    func resumeAfterPushToTalk(lease: UUID) async {
        guard pauseLeases.remove(lease) != nil else { return }
        refreshGeneration &+= 1
        guard pauseLeases.isEmpty else { return }
        cooldownUntil = Date().addingTimeInterval(debounceAfterSend)
        if let state = await state() {
            await refresh(state: state)
        }
    }

    static func trimmedAfterTrigger(_ text: String, triggers: [String]) -> String {
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty else { continue }
            guard let range = text.range(
                of: token,
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
            ) else { continue }
            return text[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    private static func commandAfterTrigger(
        transcript: String,
        segments: [WakeWordSegment],
        triggerEndTime: TimeInterval?,
        triggers: [String]
    ) -> String {
        guard let triggerEndTime else {
            return trimmedAfterTrigger(transcript, triggers: triggers)
        }
        let trimmed = WakeWordGate.commandText(
            transcript: transcript,
            segments: segments,
            triggerEndTime: triggerEndTime
        )
        return trimmed.isEmpty ? trimmedAfterTrigger(transcript, triggers: triggers) : trimmed
    }
}
