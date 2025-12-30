import AVFoundation
import ClawdisChatUI
import ClawdisKit
import Foundation
import OSLog
import Speech

actor TalkModeRuntime {
    static let shared = TalkModeRuntime()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "talk.runtime")
    private let ttsLogger = Logger(subsystem: "com.steipete.clawdis", category: "talk.tts")

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: Int = 0

    private var captureTask: Task<Void, Never>?
    private var silenceTask: Task<Void, Never>?
    private var phase: TalkModePhase = .idle
    private var isEnabled = false

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
    private var lastSpokenText: String?
    private var apiKey: String?
    private var fallbackVoiceId: String?

    private let silenceWindow: TimeInterval = 0.7
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0

    // MARK: - Lifecycle

    func setEnabled(_ enabled: Bool) async {
        guard enabled != self.isEnabled else { return }
        self.isEnabled = enabled
        if enabled {
            await self.start()
        } else {
            await self.stop()
        }
    }

    private func start() async {
        guard voiceWakeSupported else { return }
        guard PermissionManager.voiceWakePermissionsGranted() else {
            self.logger.debug("talk runtime not starting: permissions missing")
            return
        }
        await self.reloadConfig()
        await self.startRecognition()
        self.phase = .listening
        await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
        self.startSilenceMonitor()
    }

    private func stop() async {
        self.captureTask?.cancel()
        self.captureTask = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.lastSpeechEnergyAt = nil
        self.phase = .idle
        await self.stopRecognition()
        await self.stopSpeaking(reason: .manual)
        await MainActor.run {
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updatePhase(.idle)
        }
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
        await self.stopRecognition()
        self.recognitionGeneration &+= 1
        let generation = self.recognitionGeneration

        let locale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
        guard let recognizer, recognizer.isAvailable else {
            self.logger.error("talk recognizer unavailable")
            return
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        guard let request = self.recognitionRequest else { return }

        if self.audioEngine == nil {
            self.audioEngine = AVAudioEngine()
        }
        guard let audioEngine = self.audioEngine else { return }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, weak request] buffer, _ in
            request?.append(buffer)
            if let rms = Self.rmsLevel(buffer: buffer) {
                Task.detached { [weak self] in
                    await self?.noteAudioLevel(rms: rms)
                }
            }
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            self.logger.error("talk audio engine start failed: \(error.localizedDescription, privacy: .public)")
            return
        }

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
    }

    private func handleRecognition(_ update: RecognitionUpdate) async {
        guard update.generation == self.recognitionGeneration else { return }
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
        guard self.phase == .listening else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }
        let elapsed = Date().timeIntervalSince(lastHeard)
        guard elapsed >= self.silenceWindow else { return }
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
        self.lastTranscript = ""
        self.lastHeard = nil
        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
        await self.stopRecognition()
        await self.sendAndSpeak(text)
    }

    // MARK: - Gateway + TTS

    private func sendAndSpeak(_ transcript: String) async {
        await self.reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        let runId = UUID().uuidString
        let startedAt = Date().timeIntervalSince1970
        self.logger.info("talk send start runId=\(runId, privacy: .public) chars=\(prompt.count, privacy: .public)")

        do {
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: "main",
                message: prompt,
                thinking: "low",
                idempotencyKey: runId,
                attachments: [])
            self.logger.info("talk chat.send ok runId=\(response.runId, privacy: .public)")
            let completion = await self.waitForChatCompletion(
                runId: response.runId,
                timeoutSeconds: 120)
            self.logger.info("talk chat completion runId=\(response.runId, privacy: .public) state=\(String(describing: completion), privacy: .public)")
            guard completion == .final else {
                await self.startListening()
                await self.startRecognition()
                return
            }

            guard let assistantText = await self.waitForAssistantText(
                sessionKey: "main",
                since: startedAt,
                timeoutSeconds: 12)
            else {
                self.logger.warning("talk assistant text missing after completion")
                await self.startListening()
                await self.startRecognition()
                return
            }

            self.logger.info("talk assistant text len=\(assistantText.count, privacy: .public)")
            await self.playAssistant(text: assistantText)
            await self.startListening()
            await self.startRecognition()
            return
        } catch {
            self.logger.error("talk chat.send failed: \(error.localizedDescription, privacy: .public)")
            await self.startListening()
            await self.startRecognition()
            return
        }
    }

    private func buildPrompt(transcript: String) -> String {
        var lines: [String] = [
            "Talk Mode active. Reply in a concise, spoken tone.",
            "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice, e.g. {\"voice\":\"<id>\",\"once\":true}.",
        ]

        if let interrupted = self.lastInterruptedAtSeconds {
            let formatted = String(format: "%.1f", interrupted)
            lines.append("Assistant speech interrupted at \(formatted)s.")
            self.lastInterruptedAtSeconds = nil
        }

        lines.append("")
        lines.append(transcript)
        return lines.joined(separator: "\n")
    }

    private enum ChatCompletionState: CustomStringConvertible {
        case final
        case aborted
        case error
        case timeout

        var description: String {
            switch self {
            case .final: return "final"
            case .aborted: return "aborted"
            case .error: return "error"
            case .timeout: return "timeout"
            }
        }
    }

    private func waitForChatCompletion(runId: String, timeoutSeconds: Int) async -> ChatCompletionState {
        let stream = await GatewayConnection.shared.subscribe()
        return await withTaskGroup(of: ChatCompletionState.self) { group in
            group.addTask { [runId] in
                for await push in stream {
                    if case let .event(evt) = push, evt.event == "chat", let payload = evt.payload {
                        if let chat = try? JSONDecoder().decode(
                            ClawdisChatEventPayload.self,
                            from: JSONEncoder().encode(payload))
                        {
                            guard chat.runId == runId else { continue }
                            switch chat.state {
                            case .some("final"): return .final
                            case .some("aborted"): return .aborted
                            case .some("error"): return .error
                            default: break
                            }
                        }
                    }
                }
                return .timeout
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return .timeout
            }
            let result = await group.next() ?? .timeout
            group.cancelAll()
            return result
        }
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
            let decoded: [ClawdisChatMessage] = messages.compactMap { item in
                guard let data = try? JSONEncoder().encode(item) else { return nil }
                return try? JSONDecoder().decode(ClawdisChatMessage.self, from: data)
            }
            let assistant = decoded.last { message in
                guard message.role == "assistant" else { return false }
                guard let since else { return true }
                guard let timestamp = message.timestamp else { return false }
                return timestamp >= since - 0.5
            }
            guard let assistant else { return nil }
            let text = assistant.content.compactMap { $0.text }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        } catch {
            self.logger.error("talk history fetch failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func playAssistant(text: String) async {
        let parse = TalkDirectiveParser.parse(text)
        let directive = parse.directive
        let cleaned = parse.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }

        if !parse.unknownKeys.isEmpty {
            self.logger.warning("talk directive ignored keys: \(parse.unknownKeys.joined(separator: ","), privacy: .public)")
        }

        if let voice = directive?.voiceId {
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

        guard let apiKey = self.apiKey, !apiKey.isEmpty else {
            self.logger.error("talk missing ELEVENLABS_API_KEY")
            return
        }

        let requestedVoice =
            directive?.voiceId ??
            self.currentVoiceId ??
            self.defaultVoiceId
        guard let voiceId = await self.resolveVoiceId(preferred: requestedVoice, apiKey: apiKey) else {
            self.logger.error("talk missing voiceId; set talk.voiceId or ELEVENLABS_VOICE_ID")
            return
        }
        self.ttsLogger.info("talk TTS request voiceId=\(voiceId, privacy: .public) chars=\(cleaned.count, privacy: .public)")

        await self.startRecognition()
        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking
        self.lastSpokenText = cleaned

        let resolvedSpeed = Self.resolveSpeed(
            speed: directive?.speed,
            rateWPM: directive?.rateWPM,
            logger: self.logger)

        let request = ElevenLabsRequest(
            text: cleaned,
            modelId: directive?.modelId ?? self.currentModelId ?? self.defaultModelId,
            outputFormat: directive?.outputFormat ?? self.defaultOutputFormat,
            speed: resolvedSpeed,
            stability: Self.validatedUnit(directive?.stability, name: "stability", logger: self.logger),
            similarity: Self.validatedUnit(directive?.similarity, name: "similarity", logger: self.logger),
            style: Self.validatedUnit(directive?.style, name: "style", logger: self.logger),
            speakerBoost: directive?.speakerBoost,
            seed: Self.validatedSeed(directive?.seed, logger: self.logger),
            normalize: Self.validatedNormalize(directive?.normalize, logger: self.logger),
            language: Self.validatedLanguage(directive?.language, logger: self.logger))

        let synthTimeoutSeconds = max(20.0, min(90.0, Double(cleaned.count) * 0.12))
        self.ttsLogger.info("talk TTS synth timeout=\(synthTimeoutSeconds, privacy: .public)s")

        do {
            let client = ElevenLabsClient(apiKey: apiKey, logger: self.ttsLogger)
            let audio = try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await client.synthesize(voiceId: voiceId, request: request)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(synthTimeoutSeconds * 1_000_000_000))
                    throw NSError(domain: "TalkTTS", code: 408, userInfo: [
                        NSLocalizedDescriptionKey: "ElevenLabs TTS timed out after \(synthTimeoutSeconds)s",
                    ])
                }
                let data = try await group.next()!
                group.cancelAll()
                return data
            }
            self.ttsLogger.info("talk TTS response bytes=\(audio.count, privacy: .public)")
            let result = await TalkAudioPlayer.shared.play(data: audio)
            self.ttsLogger.info("talk audio result finished=\(result.finished, privacy: .public) interruptedAt=\(String(describing: result.interruptedAt), privacy: .public)")
            if !result.finished, let interruptedAt = result.interruptedAt, self.phase == .speaking {
                if self.interruptOnSpeech {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            }
        } catch {
            self.logger.error("talk TTS failed: \(error.localizedDescription, privacy: .public)")
        }

        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
    }

    private func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsClient(apiKey: apiKey, logger: self.ttsLogger).listVoices()
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
            self.ttsLogger.info("talk default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.ttsLogger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func stopSpeaking(reason: TalkStopReason) async {
        guard self.phase == .speaking else { return }
        let interruptedAt = await MainActor.run { TalkAudioPlayer.shared.stop() }
        if reason == .speech, let interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        }
        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
    }

    // MARK: - Config

    private func reloadConfig() async {
        let cfg = await self.fetchTalkConfig()
        self.defaultVoiceId = cfg.voiceId
        if !self.voiceOverrideActive {
            self.currentVoiceId = cfg.voiceId
        }
        self.defaultModelId = cfg.modelId
        if !self.modelOverrideActive {
            self.currentModelId = cfg.modelId
        }
        self.defaultOutputFormat = cfg.outputFormat
        self.interruptOnSpeech = cfg.interruptOnSpeech
        self.apiKey = cfg.apiKey
        let hasApiKey = (cfg.apiKey?.isEmpty == false)
        let voiceLabel = (cfg.voiceId?.isEmpty == false) ? cfg.voiceId! : "none"
        let modelLabel = (cfg.modelId?.isEmpty == false) ? cfg.modelId! : "none"
        self.logger.info("talk config voiceId=\(voiceLabel, privacy: .public) modelId=\(modelLabel, privacy: .public) apiKey=\(hasApiKey, privacy: .public) interrupt=\(cfg.interruptOnSpeech, privacy: .public)")
    }

    private struct TalkRuntimeConfig {
        let voiceId: String?
        let modelId: String?
        let outputFormat: String?
        let interruptOnSpeech: Bool
        let apiKey: String?
    }

    private func fetchTalkConfig() async -> TalkRuntimeConfig {
        let env = ProcessInfo.processInfo.environment
        let envVoice = env["ELEVENLABS_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sagVoice = env["SAG_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envApiKey = env["ELEVENLABS_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            let talk = snap.config?["talk"]?.dictionaryValue
            let ui = snap.config?["ui"]?.dictionaryValue
            let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            await MainActor.run {
                AppStateStore.shared.seamColorHex = rawSeam.isEmpty ? nil : rawSeam
            }
            let voice = talk?["voiceId"]?.stringValue
            let model = talk?["modelId"]?.stringValue
            let outputFormat = talk?["outputFormat"]?.stringValue
            let interrupt = talk?["interruptOnSpeech"]?.boolValue
            let apiKey = talk?["apiKey"]?.stringValue
            let resolvedVoice =
                (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil) ??
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
            let resolvedApiKey =
                (envApiKey?.isEmpty == false ? envApiKey : nil) ??
                (apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? apiKey : nil)
            return TalkRuntimeConfig(
                voiceId: resolvedVoice,
                modelId: model,
                outputFormat: outputFormat,
                interruptOnSpeech: interrupt ?? true,
                apiKey: resolvedApiKey)
        } catch {
            let resolvedVoice =
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
            let resolvedApiKey = envApiKey?.isEmpty == false ? envApiKey : nil
            return TalkRuntimeConfig(
                voiceId: resolvedVoice,
                modelId: nil,
                outputFormat: nil,
                interruptOnSpeech: true,
                apiKey: resolvedApiKey)
        }
    }

    // MARK: - Audio level handling

    private func noteAudioLevel(rms: Double) async {
        if self.phase != .listening && self.phase != .speaking { return }
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
        if value < 0 || value > 4294967295 {
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

    private static func validatedLanguage(_ value: String?, logger: Logger) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count == 2, normalized.allSatisfy({ $0 >= "a" && $0 <= "z" }) else {
            logger.warning("talk language invalid: \(normalized, privacy: .public)")
            return nil
        }
        return normalized
    }
}

private struct ElevenLabsRequest {
    let text: String
    let modelId: String?
    let outputFormat: String?
    let speed: Double?
    let stability: Double?
    let similarity: Double?
    let style: Double?
    let speakerBoost: Bool?
    let seed: UInt32?
    let normalize: String?
    let language: String?
}

private struct ElevenLabsClient {
    let apiKey: String
    let logger: Logger
    let baseUrl: URL = URL(string: "https://api.elevenlabs.io")!
    let ttsTimeoutSeconds: TimeInterval = 45
    let listVoicesTimeoutSeconds: TimeInterval = 15

    func synthesize(voiceId: String, request: ElevenLabsRequest) async throws -> Data {
        var url = self.baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("text-to-speech")
        url.appendPathComponent(voiceId)

        let charCount = request.text.count
        self.logger.info(
            "elevenlabs tts request voice=\(voiceId, privacy: .public) model=\(request.modelId ?? "default", privacy: .public) chars=\(charCount, privacy: .public)")
        let startedAt = Date()

        var payload: [String: Any] = [
            "text": request.text,
        ]
        if let modelId = request.modelId, !modelId.isEmpty {
            payload["model_id"] = modelId
        }
        if let outputFormat = request.outputFormat, !outputFormat.isEmpty {
            payload["output_format"] = outputFormat
        }
        if let seed = request.seed {
            payload["seed"] = seed
        }
        if let normalize = request.normalize {
            payload["apply_text_normalization"] = normalize
        }
        if let language = request.language {
            payload["language_code"] = language
        }
        var voiceSettings: [String: Any] = [:]
        if let speed = request.speed { voiceSettings["speed"] = speed }
        if let stability = request.stability { voiceSettings["stability"] = stability }
        if let similarity = request.similarity { voiceSettings["similarity_boost"] = similarity }
        if let style = request.style { voiceSettings["style"] = style }
        if let speakerBoost = request.speakerBoost { voiceSettings["use_speaker_boost"] = speakerBoost }
        if !voiceSettings.isEmpty {
            payload["voice_settings"] = voiceSettings
        }

        let body = try JSONSerialization.data(withJSONObject: payload, options: [])
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        req.timeoutInterval = self.ttsTimeoutSeconds
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            self.logger.error(
                "elevenlabs tts failed status=\(http.statusCode, privacy: .public) message=\(message, privacy: .public)")
            throw NSError(domain: "TalkTTS", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: \(http.statusCode) \(message)",
            ])
        }
        let elapsed = Date().timeIntervalSince(startedAt)
        self.logger.info("elevenlabs tts ok bytes=\(data.count, privacy: .public) dur=\(elapsed, privacy: .public)s")
        return data
    }

    func listVoices() async throws -> [ElevenLabsVoice] {
        var url = self.baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("voices")

        self.logger.info("elevenlabs voices list request")
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = self.listVoicesTimeoutSeconds
        req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            self.logger.error(
                "elevenlabs voices list failed status=\(http.statusCode, privacy: .public) message=\(message, privacy: .public)")
            throw NSError(domain: "TalkTTS", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs voices failed: \(http.statusCode) \(message)",
            ])
        }

        let decoded = try JSONDecoder().decode(ElevenLabsVoicesResponse.self, from: data)
        return decoded.voices
    }
}

private struct ElevenLabsVoice: Decodable {
    let voiceId: String
    let name: String?

    enum CodingKeys: String, CodingKey {
        case voiceId = "voice_id"
        case name
    }
}

private struct ElevenLabsVoicesResponse: Decodable {
    let voices: [ElevenLabsVoice]
}
