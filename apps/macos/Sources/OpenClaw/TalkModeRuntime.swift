import AVFoundation
import Foundation
import OpenClawChatUI
import OpenClawKit
import OSLog
import Speech

actor TalkModeRuntime {
    static let shared = TalkModeRuntime()

    enum PlaybackPlan: Equatable {
        case elevenLabsThenSystemVoice(apiKey: String, voiceId: String)
        case systemVoiceOnly
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.runtime")
    private let ttsLogger = Logger(subsystem: "ai.openclaw", category: "talk.tts")
    private static let defaultModelIdFallback = "eleven_v3"
    private static let defaultTalkProvider = "elevenlabs"
    private static let defaultSilenceTimeoutMs = TalkDefaults.silenceTimeoutMs
    private static let execuTorchMinSilenceWindowSeconds: TimeInterval = 1.2
    private static let execuTorchFinalizeDrainNs: UInt64 = 250_000_000

    private final class RMSMeter: @unchecked Sendable {
        private let lock = NSLock()
        private var latestRMS: Double = 0

        func set(_ rms: Double) {
            self.lock.lock()
            self.latestRMS = rms
            self.lock.unlock()
        }

        func get() -> Double {
            self.lock.lock()
            let value = self.latestRMS
            self.lock.unlock()
            return value
        }
    }

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: Int = 0
    private var rmsTask: Task<Void, Never>?
    private let rmsMeter = RMSMeter()
    private var useExecuTorch = false
    private var etBridge: ExecuTorchSTTBridge { ExecuTorchSTTBridge.shared }
    private var etTranscriptTask: Task<Void, Never>?

    private var captureTask: Task<Void, Never>?
    private var silenceTask: Task<Void, Never>?
    private var phase: TalkModePhase = .idle
    private var isEnabled = false
    private var isPaused = false
    private var lifecycleGeneration: Int = 0

    private var lastHeard: Date?
    private var noiseFloorRMS: Double = 1e-4
    private var lastTranscript: String = ""
    private var lastSpeechEnergyAt: Date?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var interruptOnSpeech: Bool = true
    private var lastInterruptedAtSeconds: Double?
    private var voiceAliases: [String: String] = [:]
    private var lastSpokenText: String?
    private var apiKey: String?
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false

    private var silenceWindow: TimeInterval = .init(TalkModeRuntime.defaultSilenceTimeoutMs) / 1000
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0

    static func configureRecognitionRequest(_ request: SFSpeechAudioBufferRecognitionRequest) {
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
    }

    // MARK: - Lifecycle

    func setEnabled(_ enabled: Bool) async {
        guard enabled != self.isEnabled else { return }
        self.logger.info("talk: setEnabled(\(enabled)) — \(enabled ? "starting" : "stopping") Talk Mode runtime")
        self.isEnabled = enabled
        self.lifecycleGeneration &+= 1
        if enabled {
            await self.start()
        } else {
            await self.stop()
        }
    }

    func setPaused(_ paused: Bool) async {
        guard paused != self.isPaused else { return }
        self.isPaused = paused
        await MainActor.run { TalkModeController.shared.updateLevel(0) }

        guard self.isEnabled else { return }

        if paused {
            self.lastTranscript = ""
            self.lastHeard = nil
            self.lastSpeechEnergyAt = nil
            await self.stopRecognition()
            return
        }

        if self.phase == .idle || self.phase == .listening {
            await self.startRecognition()
            self.phase = .listening
            await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
            self.startSilenceMonitor()
        }
    }

    private func isCurrent(_ generation: Int) -> Bool {
        generation == self.lifecycleGeneration && self.isEnabled
    }

    private func start() async {
        let gen = self.lifecycleGeneration
        self.logger.info("talk: start() entered, voiceWakeSupported=\(voiceWakeSupported)")
        guard voiceWakeSupported else {
            self.logger.warning("talk: start() aborted — voice wake not supported")
            return
        }
        guard PermissionManager.voiceWakePermissionsGranted() else {
            self.logger.warning("talk: start() aborted — permissions missing")
            return
        }
        self.logger.info("talk: reloading config...")
        await self.reloadConfig()
        let backendFromApp = await MainActor.run { AppStateStore.shared.talkSttBackend }
        self.useExecuTorch = (backendFromApp == .executorch)
        self.logger.info("talk: STT backend from app state: \(String(describing: backendFromApp.rawValue), privacy: .public) → useExecuTorch=\(self.useExecuTorch)")
        if self.useExecuTorch {
            self.logger.info("talk: STT backend ExecuTorch Parakeet-TDT — loading model...")
            await MainActor.run { TalkModeController.shared.updatePhase(.loading) }
            do {
                try await self.etBridge.loadModel()
                self.logger.info("talk: ExecuTorch model load succeeded")
            } catch {
                self.logger.error("talk: ExecuTorch model load failed: \(error.localizedDescription, privacy: .public)")
                await self.handleExecuTorchLoadFailure()
            }
        } else {
            self.logger.info("talk: STT backend Apple Speech (no ExecuTorch)")
        }
        guard self.isCurrent(gen) else {
            self.logger.info("talk: start() generation outdated, exiting")
            return
        }
        if self.isPaused {
            self.phase = .idle
            await MainActor.run {
                TalkModeController.shared.updateLevel(0)
                TalkModeController.shared.updatePhase(.idle)
            }
            return
        }
        self.logger.info("talk: starting recognition (useExecuTorch=\(self.useExecuTorch))...")
        await self.startRecognition()
        guard self.isCurrent(gen) else { return }
        self.phase = .listening
        self.logger.info("talk: recognition started, phase=listening")
        await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
        self.startSilenceMonitor()
    }

    private func stop() async {
        self.captureTask?.cancel()
        self.captureTask = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil

        // Stop audio before changing phase (stopSpeaking is gated on .speaking).
        await self.stopSpeaking(reason: .manual)

        self.lastTranscript = ""
        self.lastHeard = nil
        self.lastSpeechEnergyAt = nil
        self.phase = .idle
        await self.stopRecognition()
        if self.useExecuTorch {
            await self.etBridge.shutdown()
        }
        await MainActor.run {
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updatePhase(.idle)
        }
    }

    private func handleExecuTorchLoadFailure() async {
        await self.etBridge.shutdown()
        self.useExecuTorch = false
        self.logger.info("talk: STT backend falling back to Apple Speech")
    }

    private func handleExecuTorchRecognitionFailure(_ error: Error) async {
        self.logger.error("talk: ExecuTorch startListening failed: \(error.localizedDescription, privacy: .public)")
        await self.handleExecuTorchLoadFailure()
    }

    // MARK: - Speech recognition

    private struct RecognitionUpdate {
        let transcript: String?
        let hasConfidence: Bool
        let isFinal: Bool
        let errorDescription: String?
        let generation: Int
    }

    private func startRecognition() async {
        if self.useExecuTorch, await self.etBridge.currentState == .listening {
            // Bridge already capturing (e.g. after TTS); just re-enable emission.
            await self.etBridge.setEmissionEnabled(true)
            self.logger.info("talk: startRecognition() ExecuTorch already listening — emission re-enabled")
            return
        }
        await self.stopRecognition()
        self.recognitionGeneration &+= 1
        let generation = self.recognitionGeneration
        self.logger.info("talk: startRecognition() generation=\(generation) useExecuTorch=\(self.useExecuTorch)")

        if self.useExecuTorch {
            self.logger.info("talk: starting ExecuTorch recognition...")
            await self.startExecuTorchRecognition(generation: generation)
            return
        }

        let locale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        self.logger.info("talk: Apple Speech path — locale=\(locale, privacy: .public)")
        self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
        guard let recognizer, recognizer.isAvailable else {
            self.logger.error("talk: Apple Speech recognizer unavailable (locale=\(locale, privacy: .public))")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        Self.configureRecognitionRequest(request)
        self.recognitionRequest = request

        if self.audioEngine == nil {
            self.audioEngine = AVAudioEngine()
        }
        guard let audioEngine = self.audioEngine else { return }

        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.audioEngine = nil
            self.logger.error("talk mode: no usable audio input device")
            return
        }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        let meter = self.rmsMeter
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request, meter] buffer, _ in
            request?.append(buffer)
            if let rms = Self.rmsLevel(buffer: buffer) {
                meter.set(rms)
            }
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            self.logger.error("talk audio engine start failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        self.startRMSTicker(meter: meter)

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self, generation] result, error in
            guard let self else { return }
            let segments = result?.bestTranscription.segments ?? []
            let transcript = result?.bestTranscription.formattedString
            let update = RecognitionUpdate(
                transcript: transcript,
                hasConfidence: segments.contains { $0.confidence > 0.6 },
                isFinal: result?.isFinal ?? false,
                errorDescription: error?.localizedDescription,
                generation: generation)
            Task { await self.handleRecognition(update) }
        }
    }

    // MARK: - ExecuTorch Recognition

    private func startExecuTorchRecognition(generation: Int) async {
        self.logger.info("talk: startExecuTorchRecognition() calling etBridge.startListening...")
        do {
            try await self.etBridge.startListening { [weak self, generation] token, isFinal in
                guard let self else { return }
                Task {
                    await self.handleExecuTorchToken(token, isFinal: isFinal, generation: generation)
                }
            }
            self.logger.info("talk: ExecuTorch startListening returned (offline poll active)")
        } catch {
            await self.handleExecuTorchRecognitionFailure(error)
            guard generation == self.recognitionGeneration else { return }
            await self.startRecognition()
        }
    }

    private func handleExecuTorchToken(_ token: String, isFinal: Bool, generation: Int) async {
        guard generation == self.recognitionGeneration else { return }
        guard !self.isPaused else { return }

        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard Self.containsLetterOrDigit(trimmed) else { return }

        // ExecuTorch has no echo cancellation — during TTS playback the mic picks up
        // the speaker audio and the model transcribes it as garbage, causing an
        // interrupt → re-send → re-speak infinite loop. Suppress all input during speaking;
        // once TTS finishes the controller transitions to .listening and normal input resumes.
        guard self.phase == .listening else { return }
        self.lastTranscript = Self.mergeTranscriptForFinalize(base: self.lastTranscript, tail: trimmed)
        self.lastHeard = Date()
    }

    private func stopRecognition() async {
        self.recognitionGeneration &+= 1
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine?.inputNode.removeTap(onBus: 0)
        self.audioEngine?.stop()
        self.audioEngine = nil
        self.recognizer = nil
        self.rmsTask?.cancel()
        self.rmsTask = nil
        self.etTranscriptTask?.cancel()
        self.etTranscriptTask = nil
        if self.useExecuTorch {
            await self.etBridge.stopListening()
        }
    }

    private func startRMSTicker(meter: RMSMeter) {
        self.rmsTask?.cancel()
        self.rmsTask = Task { [weak self, meter] in
            while let self {
                try? await Task.sleep(nanoseconds: 50_000_000)
                if Task.isCancelled { return }
                await self.noteAudioLevel(rms: meter.get())
            }
        }
    }

    private func handleRecognition(_ update: RecognitionUpdate) async {
        guard update.generation == self.recognitionGeneration else { return }
        guard !self.isPaused else { return }
        if let errorDescription = update.errorDescription {
            self.logger.debug("talk recognition error: \(errorDescription, privacy: .public)")
        }
        guard let transcript = update.transcript else { return }

        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.phase == .speaking, self.interruptOnSpeech {
            if await self.shouldInterrupt(transcript: trimmed, hasConfidence: update.hasConfidence) {
                await self.stopSpeaking(reason: .speech)
                self.lastTranscript = ""
                self.lastHeard = nil
                await self.startListening()
            }
            return
        }

        guard self.phase == .listening else { return }

        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }

        if update.isFinal {
            self.lastTranscript = trimmed
        }
    }

    // MARK: - Silence handling

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            await self?.silenceLoop()
        }
    }

    private func silenceLoop() async {
        while self.isEnabled {
            try? await Task.sleep(nanoseconds: 200_000_000)
            await self.checkSilence()
        }
    }

    private func checkSilence() async {
        guard !self.isPaused else { return }
        guard self.phase == .listening else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }
        let elapsed = Date().timeIntervalSince(lastHeard)
        let requiredSilenceWindow = Self.effectiveSilenceWindow(
            configured: self.silenceWindow,
            useExecuTorch: self.useExecuTorch)
        guard elapsed >= requiredSilenceWindow else { return }
        await self.finalizeTranscript(transcript)
    }

    private func startListening() async {
        self.phase = .listening
        self.lastTranscript = ""
        self.lastHeard = nil
        await MainActor.run {
            TalkModeController.shared.updatePhase(.listening)
            TalkModeController.shared.updateLevel(0)
        }
    }

    private func finalizeTranscript(_ text: String) async {
        var finalTranscript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.useExecuTorch {
            // Give the converter/tap pipeline a short drain window so the last spoken
            // word lands in the rolling buffer before the forced finalize decode.
            try? await Task.sleep(nanoseconds: Self.execuTorchFinalizeDrainNs)
            let finalizeTailDelta = await self.etBridge.forceFinalOfflineDecodeDelta(baseTranscript: finalTranscript)
            if !finalizeTailDelta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                finalTranscript = Self.mergeTranscriptForFinalize(base: finalTranscript, tail: finalizeTailDelta)
            }
        }

        guard !finalTranscript.isEmpty else {
            await self.startListening()
            await self.startRecognition()
            return
        }

        self.lastTranscript = ""
        self.lastHeard = nil
        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
        if self.useExecuTorch {
            await self.etBridge.recordFinalizeLatency()
        }
        await self.stopRecognition()
        await self.sendAndSpeak(finalTranscript)
    }

    // MARK: - Gateway + TTS

    private func sendAndSpeak(_ transcript: String) async {
        let gen = self.lifecycleGeneration
        await self.reloadConfig()
        guard self.isCurrent(gen) else { return }
        let prompt = self.buildPrompt(transcript: transcript)
        let activeSessionKey = await MainActor.run { WebChatManager.shared.activeSessionKey }
        let sessionKey: String = if let activeSessionKey {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }
        let runId = UUID().uuidString
        let startedAt = Date().timeIntervalSince1970
        self.logger.info(
            "talk send start runId=\(runId, privacy: .public) " +
                "session=\(sessionKey, privacy: .public) " +
                "chars=\(prompt.count, privacy: .public)")

        do {
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                message: prompt,
                thinking: "low",
                idempotencyKey: runId,
                attachments: [])
            guard self.isCurrent(gen) else { return }
            self.logger.info(
                "talk chat.send ok runId=\(response.runId, privacy: .public) " +
                    "session=\(sessionKey, privacy: .public)")

            guard let assistantText = await self.waitForAssistantText(
                sessionKey: sessionKey,
                since: startedAt,
                timeoutSeconds: 45)
            else {
                self.logger.warning("talk assistant text missing after timeout")
                await self.startListening()
                await self.startRecognition()
                return
            }
            guard self.isCurrent(gen) else { return }

            self.logger.info("talk assistant text len=\(assistantText.count, privacy: .public)")
            await self.playAssistant(text: assistantText)
            guard self.isCurrent(gen) else { return }
            await self.resumeListeningIfNeeded()
            return
        } catch {
            self.logger.error("talk chat.send failed: \(error.localizedDescription, privacy: .public)")
            await self.resumeListeningIfNeeded()
            return
        }
    }

    private func resumeListeningIfNeeded() async {
        if self.isPaused {
            self.lastTranscript = ""
            self.lastHeard = nil
            self.lastSpeechEnergyAt = nil
            await MainActor.run {
                TalkModeController.shared.updateLevel(0)
            }
            return
        }
        await self.startListening()
        await self.startRecognition()
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        let sttBackend = self.useExecuTorch ? "ExecuTorch Parakeet-TDT" : "Apple Speech"
        var debugHint: String?
        if !self.useExecuTorch {
            let bundleId = Bundle.main.bundleIdentifier
            let raw = UserDefaults.standard.string(forKey: talkSttBackendKey) ?? "nil"
            if let bundleId {
                debugHint = "bundle=\(bundleId), raw=\(raw). To use Parakeet run: defaults write \(bundleId) openclaw.talkSttBackend executorch"
            } else {
                debugHint = "bundle=nil (raw executable from Xcode). Try: defaults write OpenClaw openclaw.talkSttBackend executorch then quit and relaunch. Or run the packaged app (dist/OpenClaw.app) and use: defaults write ai.openclaw.mac.debug openclaw.talkSttBackend executorch"
            }
        }
        return TalkPromptBuilder.build(
            transcript: transcript,
            interruptedAtSeconds: interrupted,
            sttBackendName: sttBackend,
            sttBackendDebugHint: debugHint
        )
    }

    private func waitForAssistantText(
        sessionKey: String,
        since: Double,
        timeoutSeconds: Int) async -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = await self.latestAssistantText(sessionKey: sessionKey, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func latestAssistantText(sessionKey: String, since: Double? = nil) async -> String? {
        do {
            let history = try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey)
            let messages = history.messages ?? []
            let decoded: [OpenClawChatMessage] = messages.compactMap { item in
                guard let data = try? JSONEncoder().encode(item) else { return nil }
                return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
            }
            let assistant = decoded.last { message in
                guard message.role == "assistant" else { return false }
                guard let since else { return true }
                guard let timestamp = message.timestamp else { return false }
                return TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since)
            }
            guard let assistant else { return nil }
            let text = assistant.content.compactMap(\.text).joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        } catch {
            self.logger.error("talk history fetch failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func playAssistant(text: String) async {
        guard let input = await self.preparePlaybackInput(text: text) else { return }
        switch Self.playbackPlan(apiKey: input.apiKey, voiceId: input.voiceId) {
        case let .elevenLabsThenSystemVoice(apiKey, voiceId):
            do {
                try await self.playElevenLabs(input: input, apiKey: apiKey, voiceId: voiceId)
            } catch {
                self.ttsLogger
                    .error(
                        "talk TTS failed: \(error.localizedDescription, privacy: .public); " +
                            "falling back to system voice")
                do {
                    try await self.playSystemVoice(input: input)
                } catch {
                    self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        case .systemVoiceOnly:
            do {
                try await self.playSystemVoice(input: input)
            } catch {
                self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        if self.phase == .speaking {
            self.phase = .thinking
            await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
        }
    }

    static func playbackPlan(apiKey: String?, voiceId: String?) -> PlaybackPlan {
        guard let apiKey, !apiKey.isEmpty, let voiceId else {
            return .systemVoiceOnly
        }
        return .elevenLabsThenSystemVoice(apiKey: apiKey, voiceId: voiceId)
    }

    private struct TalkPlaybackInput {
        let generation: Int
        let cleanedText: String
        let directive: TalkDirective?
        let apiKey: String?
        let voiceId: String?
        let language: String?
        let synthTimeoutSeconds: Double
    }

    private func preparePlaybackInput(text: String) async -> TalkPlaybackInput? {
        let gen = self.lifecycleGeneration
        let parse = TalkDirectiveParser.parse(text)
        let directive = parse.directive
        let cleaned = parse.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        guard self.isCurrent(gen) else { return nil }

        if !parse.unknownKeys.isEmpty {
            self.logger
                .warning(
                    "talk directive ignored keys: " +
                        "\(parse.unknownKeys.joined(separator: ","), privacy: .public)")
        }

        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if let requestedVoice, !requestedVoice.isEmpty, resolvedVoice == nil {
            self.logger.warning("talk unknown voice alias \(requestedVoice, privacy: .public)")
        }
        if let voice = resolvedVoice {
            if directive?.once == true {
                self.logger.info("talk voice override (once) voiceId=\(voice, privacy: .public)")
            } else {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
                self.logger.info("talk voice override voiceId=\(voice, privacy: .public)")
            }
        }

        if let model = directive?.modelId {
            if directive?.once == true {
                self.logger.info("talk model override (once) modelId=\(model, privacy: .public)")
            } else {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }

        let apiKey = self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let preferredVoice =
            resolvedVoice ??
            self.currentVoiceId ??
            self.defaultVoiceId

        let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)

        let voiceId: String? = if let apiKey, !apiKey.isEmpty {
            await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
        } else {
            nil
        }

        if apiKey?.isEmpty != false {
            self.ttsLogger.warning("talk TTS: missing ELEVENLABS_API_KEY; falling back to system voice")
        } else if voiceId == nil {
            self.ttsLogger.warning("talk TTS: missing voiceId; falling back to system voice")
        } else if let voiceId {
            self.ttsLogger
                .info(
                    "talk TTS request voiceId=\(voiceId, privacy: .public) " +
                        "chars=\(cleaned.count, privacy: .public)")
        }
        self.lastSpokenText = cleaned

        let synthTimeoutSeconds = max(20.0, min(90.0, Double(cleaned.count) * 0.12))

        guard self.isCurrent(gen) else { return nil }

        return TalkPlaybackInput(
            generation: gen,
            cleanedText: cleaned,
            directive: directive,
            apiKey: apiKey,
            voiceId: voiceId,
            language: language,
            synthTimeoutSeconds: synthTimeoutSeconds)
    }

    private func playElevenLabs(input: TalkPlaybackInput, apiKey: String, voiceId: String) async throws {
        let desiredOutputFormat = input.directive?.outputFormat ?? self.defaultOutputFormat ?? "pcm_44100"
        let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(desiredOutputFormat)
        if outputFormat == nil, !desiredOutputFormat.isEmpty {
            self.logger
                .warning(
                    "talk output_format unsupported for local playback: " +
                        "\(desiredOutputFormat, privacy: .public)")
        }

        let modelId = input.directive?.modelId ?? self.currentModelId ?? self.defaultModelId
        func makeRequest(outputFormat: String?) -> ElevenLabsTTSRequest {
            ElevenLabsTTSRequest(
                text: input.cleanedText,
                modelId: modelId,
                outputFormat: outputFormat,
                speed: TalkTTSValidation.resolveSpeed(
                    speed: input.directive?.speed,
                    rateWPM: input.directive?.rateWPM),
                stability: TalkTTSValidation.validatedStability(
                    input.directive?.stability,
                    modelId: modelId),
                similarity: TalkTTSValidation.validatedUnit(input.directive?.similarity),
                style: TalkTTSValidation.validatedUnit(input.directive?.style),
                speakerBoost: input.directive?.speakerBoost,
                seed: TalkTTSValidation.validatedSeed(input.directive?.seed),
                normalize: ElevenLabsTTSClient.validatedNormalize(input.directive?.normalize),
                language: input.language,
                latencyTier: TalkTTSValidation.validatedLatencyTier(input.directive?.latencyTier))
        }

        let request = makeRequest(outputFormat: outputFormat)
        self.ttsLogger.info("talk TTS synth timeout=\(input.synthTimeoutSeconds, privacy: .public)s")
        let client = ElevenLabsTTSClient(apiKey: apiKey)
        let stream = client.streamSynthesize(voiceId: voiceId, request: request)
        guard self.isCurrent(input.generation) else { return }

        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }

        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking

        let result = await self.playRemoteStream(
            client: client,
            voiceId: voiceId,
            outputFormat: outputFormat,
            makeRequest: makeRequest,
            stream: stream)
        self.ttsLogger
            .info(
                "talk audio result finished=\(result.finished, privacy: .public) " +
                    "interruptedAt=\(String(describing: result.interruptedAt), privacy: .public)")
        if !result.finished, result.interruptedAt == nil {
            throw NSError(domain: "StreamingAudioPlayer", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "audio playback failed",
            ])
        }
        if !result.finished, let interruptedAt = result.interruptedAt, self.phase == .speaking {
            if self.interruptOnSpeech {
                self.lastInterruptedAtSeconds = interruptedAt
            }
        }
    }

    private func playRemoteStream(
        client: ElevenLabsTTSClient,
        voiceId: String,
        outputFormat: String?,
        makeRequest: (String?) -> ElevenLabsTTSRequest,
        stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult
    {
        let sampleRate = TalkTTSValidation.pcmSampleRate(from: outputFormat)
        if let sampleRate {
            self.lastPlaybackWasPCM = true
            let result = await self.playPCM(stream: stream, sampleRate: sampleRate)
            if result.finished || result.interruptedAt != nil {
                return result
            }
            let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100")
            self.ttsLogger.warning("talk pcm playback failed; retrying mp3")
            self.lastPlaybackWasPCM = false
            let mp3Stream = client.streamSynthesize(
                voiceId: voiceId,
                request: makeRequest(mp3Format))
            return await self.playMP3(stream: mp3Stream)
        }
        self.lastPlaybackWasPCM = false
        return await self.playMP3(stream: stream)
    }

    private func playSystemVoice(input: TalkPlaybackInput) async throws {
        self.ttsLogger.info("talk system voice start chars=\(input.cleanedText.count, privacy: .public)")
        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }
        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking
        await TalkSystemSpeechSynthesizer.shared.stop()
        // Use app locale as fallback when no explicit language is set (e.g. system voice without ElevenLabs directive).
        let appLocale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        let ttsLanguage = input.language ?? appLocale
        try await TalkSystemSpeechSynthesizer.shared.speak(
            text: input.cleanedText,
            language: ttsLanguage)
        self.ttsLogger.info("talk system voice done")
    }

    private func prepareForPlayback(generation: Int) async -> Bool {
        if self.useExecuTorch {
            // Keep capture running but suppress transcript emission during TTS (no echo cancellation).
            self.lastTranscript = ""
            self.lastHeard = nil
            self.lastSpeechEnergyAt = nil
            await self.etBridge.setEmissionEnabled(false)
        } else {
            await self.startRecognition()
        }
        return self.isCurrent(generation)
    }

    private func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            if let resolved = self.resolveVoiceAlias(trimmed) { return resolved }
            self.ttsLogger.warning("talk unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.ttsLogger.error("elevenlabs voices list empty")
                return nil
            }
            self.fallbackVoiceId = first.voiceId
            if self.defaultVoiceId == nil {
                self.defaultVoiceId = first.voiceId
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = first.voiceId
            }
            let name = first.name ?? "unknown"
            self.ttsLogger
                .info("talk default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.ttsLogger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func resolveVoiceAlias(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.lowercased()
        if let mapped = self.voiceAliases[normalized] { return mapped }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    private static func isLikelyVoiceId(_ value: String) -> Bool {
        guard value.count >= 10 else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private static func containsLetterOrDigit(_ value: String) -> Bool {
        value.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
    }

    private static func effectiveSilenceWindow(configured: TimeInterval, useExecuTorch: Bool) -> TimeInterval {
        if useExecuTorch {
            return max(configured, Self.execuTorchMinSilenceWindowSeconds)
        }
        return configured
    }

    private static func mergeTranscriptForFinalize(base: String, tail: String) -> String {
        let baseTrimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let tailTrimmed = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tailTrimmed.isEmpty else { return baseTrimmed }
        guard !baseTrimmed.isEmpty else { return tailTrimmed }
        if baseTrimmed.hasSuffix(tailTrimmed) {
            return baseTrimmed
        }
        if tailTrimmed.hasPrefix(baseTrimmed) {
            return tailTrimmed
        }
        let overlap = Self.suffixPrefixOverlap(previous: baseTrimmed, current: tailTrimmed)
        if overlap > 0 {
            return baseTrimmed + String(tailTrimmed.dropFirst(overlap))
        }
        if Self.shouldTreatAsCompetingHypothesis(base: baseTrimmed, tail: tailTrimmed) {
            return Self.preferHypothesis(base: baseTrimmed, tail: tailTrimmed)
        }
        return baseTrimmed + " " + tailTrimmed
    }

    private static func suffixPrefixOverlap(previous: String, current: String) -> Int {
        let previousChars = Array(previous)
        let currentChars = Array(current)
        let maxOverlap = min(previousChars.count, currentChars.count)
        guard maxOverlap > 0 else { return 0 }
        for overlap in stride(from: maxOverlap, through: 1, by: -1) {
            if previousChars.suffix(overlap).elementsEqual(currentChars.prefix(overlap)) {
                return overlap
            }
        }
        return 0
    }

    /// Parakeet polling can emit revised full hypotheses, not just append-only tails.
    /// Treat similar full phrases as competing alternatives and choose one instead of concatenating.
    private static func shouldTreatAsCompetingHypothesis(base: String, tail: String) -> Bool {
        let baseTokens = Self.normalizedTokens(base)
        let tailTokens = Self.normalizedTokens(tail)
        guard baseTokens.count >= 3, tailTokens.count >= 3 else { return false }

        let similarity = Self.tokenJaccardSimilarity(baseTokens, tailTokens)
        if similarity >= 0.35 { return true }
        return Self.looksCompleteUtterance(base) && Self.looksCompleteUtterance(tail)
    }

    private static func preferHypothesis(base: String, tail: String) -> String {
        let baseTokens = Self.normalizedTokens(base)
        let tailTokens = Self.normalizedTokens(tail)
        let similarity = Self.tokenJaccardSimilarity(baseTokens, tailTokens)

        // Favor richer hypotheses, but avoid replacing a stable long phrase with a shorter regression.
        if tailTokens.count >= baseTokens.count + 2 {
            return tail
        }
        if baseTokens.count >= tailTokens.count + 2, similarity >= 0.30 {
            return base
        }
        return tail
    }

    private static func normalizedTokens(_ value: String) -> [String] {
        value
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    private static func tokenJaccardSimilarity(_ lhs: [String], _ rhs: [String]) -> Double {
        let leftSet = Set(lhs)
        let rightSet = Set(rhs)
        let union = leftSet.union(rightSet)
        guard !union.isEmpty else { return 0 }
        let intersection = leftSet.intersection(rightSet)
        return Double(intersection.count) / Double(union.count)
    }

    private static func looksCompleteUtterance(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if let last = trimmed.unicodeScalars.last, CharacterSet(charactersIn: ".!?").contains(last) {
            return true
        }
        return Self.normalizedTokens(trimmed).count >= 5
    }

    func stopSpeaking(reason: TalkStopReason) async {
        let usePCM = self.lastPlaybackWasPCM
        let interruptedAt = usePCM ? await self.stopPCM() : await self.stopMP3()
        _ = usePCM ? await self.stopMP3() : await self.stopPCM()
        await TalkSystemSpeechSynthesizer.shared.stop()
        guard self.phase == .speaking else { return }
        if reason == .speech, let interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        }
        if reason == .manual {
            return
        }
        if reason == .speech || reason == .userTap {
            await self.startListening()
            await self.startRecognition()
            return
        }
        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
    }
}

#if DEBUG
extension TalkModeRuntime {
    static func _testMergeTranscriptForFinalize(base: String, tail: String) -> String {
        mergeTranscriptForFinalize(base: base, tail: tail)
    }

    static func _testEffectiveSilenceWindow(configured: TimeInterval, useExecuTorch: Bool) -> TimeInterval {
        effectiveSilenceWindow(configured: configured, useExecuTorch: useExecuTorch)
    }

    func _testHandleExecuTorchLoadFailure() async -> (useExecuTorch: Bool, bridgeState: ExecuTorchSTTBridge.State) {
        self.useExecuTorch = true
        await self.etBridge._testSetState(.error("test"))
        await self.handleExecuTorchLoadFailure()
        return (self.useExecuTorch, await self.etBridge.currentState)
    }

    func _testHandleExecuTorchRecognitionFailure() async -> (useExecuTorch: Bool, bridgeState: ExecuTorchSTTBridge.State) {
        self.useExecuTorch = true
        await self.etBridge._testSetState(.ready)
        await self.handleExecuTorchRecognitionFailure(ExecuTorchError.audioConversionFailed)
        return (self.useExecuTorch, await self.etBridge.currentState)
    }
}
#endif

extension TalkModeRuntime {
    // MARK: - Audio playback (MainActor helpers)

    @MainActor
    private func playPCM(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        await PCMStreamingAudioPlayer.shared.play(stream: stream, sampleRate: sampleRate)
    }

    @MainActor
    private func playMP3(stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult {
        await StreamingAudioPlayer.shared.play(stream: stream)
    }

    @MainActor
    private func stopPCM() -> Double? {
        PCMStreamingAudioPlayer.shared.stop()
    }

    @MainActor
    private func stopMP3() -> Double? {
        StreamingAudioPlayer.shared.stop()
    }

    // MARK: - Config

    private func reloadConfig() async {
        let cfg = await self.fetchTalkConfig()
        self.defaultVoiceId = cfg.voiceId
        self.voiceAliases = cfg.voiceAliases
        if !self.voiceOverrideActive {
            self.currentVoiceId = cfg.voiceId
        }
        self.defaultModelId = cfg.modelId
        if !self.modelOverrideActive {
            self.currentModelId = cfg.modelId
        }
        self.defaultOutputFormat = cfg.outputFormat
        self.interruptOnSpeech = cfg.interruptOnSpeech
        self.silenceWindow = TimeInterval(cfg.silenceTimeoutMs) / 1000
        self.apiKey = cfg.apiKey
        let hasApiKey = (cfg.apiKey?.isEmpty == false)
        let voiceLabel = (cfg.voiceId?.isEmpty == false) ? cfg.voiceId! : "none"
        let modelLabel = (cfg.modelId?.isEmpty == false) ? cfg.modelId! : "none"
        self.logger
            .info(
                "talk config voiceId=\(voiceLabel, privacy: .public) " +
                    "modelId=\(modelLabel, privacy: .public) " +
                    "apiKey=\(hasApiKey, privacy: .public) " +
                    "interrupt=\(cfg.interruptOnSpeech, privacy: .public) " +
                    "silenceTimeoutMs=\(cfg.silenceTimeoutMs, privacy: .public)")
    }

    static func selectTalkProviderConfig(
        _ talk: [String: AnyCodable]?) -> TalkProviderConfigSelection?
    {
        TalkConfigParsing.selectProviderConfig(talk, defaultProvider: self.defaultTalkProvider)
    }

    static func resolvedSilenceTimeoutMs(_ talk: [String: AnyCodable]?) -> Int {
        TalkConfigParsing.resolvedSilenceTimeoutMs(talk, fallback: self.defaultSilenceTimeoutMs)
    }

    private func fetchTalkConfig() async -> TalkModeGatewayConfigState {
        let env = ProcessInfo.processInfo.environment
        let envVoice = env["ELEVENLABS_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sagVoice = env["SAG_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envApiKey = env["ELEVENLABS_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .talkConfig,
                params: ["includeSecrets": AnyCodable(true)],
                timeoutMs: 8000)
            let parsed = TalkModeGatewayConfigParser.parse(
                snapshot: snap,
                defaultProvider: Self.defaultTalkProvider,
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
                envVoice: envVoice,
                sagVoice: sagVoice,
                envApiKey: envApiKey)
            if parsed.missingResolvedPayload {
                self.ttsLogger.info("talk config ignored: normalized payload missing talk.resolved")
            }
            await MainActor.run {
                AppStateStore.shared.seamColorHex = parsed.seamColorHex
            }
            if parsed.activeProvider != Self.defaultTalkProvider {
                self.ttsLogger
                    .info("talk provider \(parsed.activeProvider, privacy: .public) unsupported; using system voice")
            } else if parsed.normalizedPayload {
                self.ttsLogger.info("talk config provider from talk.resolved")
            }
            return parsed
        } catch {
            return TalkModeGatewayConfigParser.fallback(
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
                envVoice: envVoice,
                sagVoice: sagVoice,
                envApiKey: envApiKey)
        }
    }

    // MARK: - Audio level handling

    private func noteAudioLevel(rms: Double) async {
        if self.phase != .listening, self.phase != .speaking { return }
        let alpha: Double = rms < self.noiseFloorRMS ? 0.08 : 0.01
        self.noiseFloorRMS = max(1e-7, self.noiseFloorRMS + (rms - self.noiseFloorRMS) * alpha)

        let threshold = max(self.minSpeechRMS, self.noiseFloorRMS * self.speechBoostFactor)
        if rms >= threshold {
            let now = Date()
            self.lastHeard = now
            self.lastSpeechEnergyAt = now
        }

        if self.phase == .listening {
            let clamped = min(1.0, max(0.0, rms / max(self.minSpeechRMS, threshold)))
            await MainActor.run { TalkModeController.shared.updateLevel(clamped) }
        }
    }

    private static func rmsLevel(buffer: AVAudioPCMBuffer) -> Double? {
        guard let channelData = buffer.floatChannelData?.pointee else { return nil }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return nil }
        var sum: Double = 0
        for i in 0..<frameCount {
            let sample = Double(channelData[i])
            sum += sample * sample
        }
        return sqrt(sum / Double(frameCount))
    }

    private func shouldInterrupt(transcript: String, hasConfidence: Bool) async -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if self.isLikelyEcho(of: trimmed) { return false }
        let now = Date()
        if let lastSpeechEnergyAt, now.timeIntervalSince(lastSpeechEnergyAt) > 0.35 {
            return false
        }
        return hasConfidence
    }

    private func isLikelyEcho(of transcript: String) -> Bool {
        guard let spoken = self.lastSpokenText?.lowercased(), !spoken.isEmpty else { return false }
        let probe = transcript.lowercased()
        if probe.count < 6 {
            return spoken.contains(probe)
        }
        return spoken.contains(probe)
    }

    private static func resolveSpeed(speed: Double?, rateWPM: Int?, logger: Logger) -> Double? {
        if let rateWPM, rateWPM > 0 {
            let resolved = Double(rateWPM) / 175.0
            if resolved <= 0.5 || resolved >= 2.0 {
                logger.warning("talk rateWPM out of range: \(rateWPM, privacy: .public)")
                return nil
            }
            return resolved
        }
        if let speed {
            if speed <= 0.5 || speed >= 2.0 {
                logger.warning("talk speed out of range: \(speed, privacy: .public)")
                return nil
            }
            return speed
        }
        return nil
    }

    private static func validatedUnit(_ value: Double?, name: String, logger: Logger) -> Double? {
        guard let value else { return nil }
        if value < 0 || value > 1 {
            logger.warning("talk \(name, privacy: .public) out of range: \(value, privacy: .public)")
            return nil
        }
        return value
    }

    private static func validatedSeed(_ value: Int?, logger: Logger) -> UInt32? {
        guard let value else { return nil }
        if value < 0 || value > 4_294_967_295 {
            logger.warning("talk seed out of range: \(value, privacy: .public)")
            return nil
        }
        return UInt32(value)
    }

    private static func validatedNormalize(_ value: String?, logger: Logger) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["auto", "on", "off"].contains(normalized) else {
            logger.warning("talk normalize invalid: \(normalized, privacy: .public)")
            return nil
        }
        return normalized
    }
}
