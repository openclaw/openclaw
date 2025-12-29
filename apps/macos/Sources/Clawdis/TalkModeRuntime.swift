import AVFoundation
import ClawdisChatUI
import ClawdisKit
import Foundation
import OSLog
import Speech

actor TalkModeRuntime {
    static let shared = TalkModeRuntime()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "talk.runtime")

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

        do {
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: "main",
                message: prompt,
                thinking: "low",
                idempotencyKey: runId,
                attachments: [])
            let completion = await self.waitForChatCompletion(
                runId: response.runId,
                timeoutSeconds: 120)
            guard completion == .final else {
                await self.startListening()
                await self.startRecognition()
                return
            }

            guard let assistantText = await self.latestAssistantText(sessionKey: "main") else {
                await self.startListening()
                await self.startRecognition()
                return
            }

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

    private enum ChatCompletionState {
        case final
        case aborted
        case error
        case timeout
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

    private func latestAssistantText(sessionKey: String) async -> String? {
        do {
            let history = try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey)
            let messages = history.messages ?? []
            let decoded: [ClawdisChatMessage] = messages.compactMap { item in
                guard let data = try? JSONEncoder().encode(item) else { return nil }
                return try? JSONDecoder().decode(ClawdisChatMessage.self, from: data)
            }
            guard let assistant = decoded.last(where: { $0.role == "assistant" }) else { return nil }
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

        let voiceId =
            directive?.voiceId ??
            self.currentVoiceId ??
            self.defaultVoiceId

        guard let voiceId, !voiceId.isEmpty else {
            self.logger.error("talk missing voiceId; set talk.voiceId or ELEVENLABS_VOICE_ID")
            return
        }

        let apiKey = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"] ?? ""
        if apiKey.isEmpty {
            self.logger.error("talk missing ELEVENLABS_API_KEY")
            return
        }

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

        do {
            let audio = try await ElevenLabsClient(apiKey: apiKey).synthesize(
                voiceId: voiceId,
                request: request)
            let result = await TalkAudioPlayer.shared.play(data: audio)
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
    }

    private struct TalkRuntimeConfig {
        let voiceId: String?
        let modelId: String?
        let outputFormat: String?
        let interruptOnSpeech: Bool
    }

    private func fetchTalkConfig() async -> TalkRuntimeConfig {
        let env = ProcessInfo.processInfo.environment
        let envVoice = env["ELEVENLABS_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sagVoice = env["SAG_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            let talk = snap.config?["talk"]?.dictionaryValue
            let voice = talk?["voiceId"]?.stringValue
            let model = talk?["modelId"]?.stringValue
            let outputFormat = talk?["outputFormat"]?.stringValue
            let interrupt = talk?["interruptOnSpeech"]?.boolValue
            let resolvedVoice =
                (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil) ??
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
            return TalkRuntimeConfig(
                voiceId: resolvedVoice,
                modelId: model,
                outputFormat: outputFormat,
                interruptOnSpeech: interrupt ?? true)
        } catch {
            let resolvedVoice =
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
            return TalkRuntimeConfig(
                voiceId: resolvedVoice,
                modelId: nil,
                outputFormat: nil,
                interruptOnSpeech: true)
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
    let baseUrl: URL = URL(string: "https://api.elevenlabs.io")!

    func synthesize(voiceId: String, request: ElevenLabsRequest) async throws -> Data {
        var url = self.baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("text-to-speech")
        url.appendPathComponent(voiceId)

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
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw NSError(domain: "TalkTTS", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: \(http.statusCode) \(message)",
            ])
        }
        return data
    }
}
