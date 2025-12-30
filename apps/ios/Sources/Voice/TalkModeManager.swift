import AVFAudio
import ClawdisKit
import Foundation
import Observation
import OSLog
import Speech

@MainActor
@Observable
final class TalkModeManager: NSObject {
    private typealias SpeechRequest = SFSpeechAudioBufferRecognitionRequest
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var statusText: String = "Off"

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var apiKey: String?
    private var interruptOnSpeech: Bool = true
    private var mainSessionKey: String = "main"

    private var bridge: BridgeSession?
    private let silenceWindow: TimeInterval = 0.7

    private var player: AVAudioPlayer?
    private var chatSubscribedSessionKeys = Set<String>()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "TalkMode")

    func attachBridge(_ bridge: BridgeSession) {
        self.bridge = bridge
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("enabled")
            Task { await self.start() }
        } else {
            self.logger.info("disabled")
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }

        self.logger.info("start")
        self.statusText = "Requesting permissions…"
        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.statusText = "Microphone permission denied"
            return
        }
        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.statusText = "Speech recognition permission denied"
            return
        }

        await self.reloadConfig()
        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            self.statusText = "Listening"
            self.startSilenceMonitor()
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.logger.info("listening")
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.statusText = "Off"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }
        Task { await self.unsubscribeAllChats() }
    }

    func userTappedOrb() {
        self.stopSpeaking()
    }

    private func startRecognition() throws {
        self.stopRecognition()
        self.speechRecognizer = SFSpeechRecognizer()
        guard let recognizer = self.speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        guard let request = self.recognitionRequest else { return }

        let input = self.audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        let tapBlock = Self.makeAudioTapAppendCallback(request: request)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)

        self.audioEngine.prepare()
        try self.audioEngine.start()

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                if !self.isSpeaking {
                    self.statusText = "Speech error: \(error.localizedDescription)"
                }
                self.logger.debug("speech recognition error: \(error.localizedDescription, privacy: .public)")
            }
            guard let result else { return }
            let transcript = result.bestTranscription.formattedString
            Task { @MainActor in
                await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
        self.speechRecognizer = nil
    }

    private nonisolated static func makeAudioTapAppendCallback(request: SpeechRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
        }
    }

    private func handleTranscript(transcript: String, isFinal: Bool) async {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.isSpeaking, self.interruptOnSpeech {
            if self.shouldInterrupt(with: trimmed) {
                self.stopSpeaking()
            }
            return
        }

        guard self.isListening else { return }
        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }
        if isFinal {
            self.lastTranscript = trimmed
        }
    }

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled {
                try? await Task.sleep(nanoseconds: 200_000_000)
                await self.checkSilence()
            }
        }
    }

    private func checkSilence() async {
        guard self.isListening, !self.isSpeaking else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }
        if Date().timeIntervalSince(lastHeard) < self.silenceWindow { return }
        await self.finalizeTranscript(transcript)
    }

    private func finalizeTranscript(_ transcript: String) async {
        self.isListening = false
        self.statusText = "Thinking…"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.stopRecognition()

        await self.reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        guard let bridge else {
            self.statusText = "Bridge not connected"
            self.logger.warning("finalize: bridge not connected")
            await self.start()
            return
        }

        do {
            let startedAt = Date().timeIntervalSince1970
            let sessionKey = self.mainSessionKey
            await self.subscribeChatIfNeeded(sessionKey: sessionKey)
            self.logger.info("chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            let runId = try await self.sendChat(prompt, bridge: bridge)
            self.logger.info("chat.send ok runId=\(runId, privacy: .public)")
            let completion = await self.waitForChatCompletion(runId: runId, bridge: bridge, timeoutSeconds: 120)
            if completion == .timeout {
                self.logger.warning("chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
            } else if completion == .aborted {
                self.statusText = "Aborted"
                self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                await self.start()
                return
            } else if completion == .error {
                self.statusText = "Chat error"
                self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                await self.start()
                return
            }

            guard let assistantText = try await self.waitForAssistantText(
                bridge: bridge,
                since: startedAt,
                timeoutSeconds: completion == .final ? 12 : 25)
            else {
                self.statusText = "No reply"
                self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
                await self.start()
                return
            }
            self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
            await self.playAssistant(text: assistantText)
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
        }

        await self.start()
    }

    private func subscribeChatIfNeeded(sessionKey: String) async {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        guard let bridge else { return }
        guard !self.chatSubscribedSessionKeys.contains(key) else { return }

        do {
            let payload = "{\"sessionKey\":\"\(key)\"}"
            try await bridge.sendEvent(event: "chat.subscribe", payloadJSON: payload)
            self.chatSubscribedSessionKeys.insert(key)
            self.logger.info("chat.subscribe ok sessionKey=\(key, privacy: .public)")
        } catch {
            self.logger
                .warning(
                    "chat.subscribe failed sessionKey=\(key, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    private func unsubscribeAllChats() async {
        guard let bridge else { return }
        let keys = self.chatSubscribedSessionKeys
        self.chatSubscribedSessionKeys.removeAll()
        for key in keys {
            do {
                let payload = "{\"sessionKey\":\"\(key)\"}"
                try await bridge.sendEvent(event: "chat.unsubscribe", payloadJSON: payload)
            } catch {
                // ignore
            }
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
            case .final: "final"
            case .aborted: "aborted"
            case .error: "error"
            case .timeout: "timeout"
            }
        }
    }

    private func sendChat(_ message: String, bridge: BridgeSession) async throws -> String {
        struct SendResponse: Decodable { let runId: String }
        let payload: [String: Any] = [
            "sessionKey": self.mainSessionKey,
            "message": message,
            "thinking": "low",
            "timeoutMs": 30000,
            "idempotencyKey": UUID().uuidString,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        let json = String(decoding: data, as: UTF8.self)
        let res = try await bridge.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 30)
        let decoded = try JSONDecoder().decode(SendResponse.self, from: res)
        return decoded.runId
    }

    private func waitForChatCompletion(
        runId: String,
        bridge: BridgeSession,
        timeoutSeconds: Int = 120) async -> ChatCompletionState
    {
        let stream = await bridge.subscribeServerEvents(bufferingNewest: 200)
        return await withTaskGroup(of: ChatCompletionState.self) { group in
            group.addTask { [runId] in
                for await evt in stream {
                    if Task.isCancelled { return .timeout }
                    guard evt.event == "chat", let payload = evt.payloadJSON else { continue }
                    guard let data = payload.data(using: .utf8) else { continue }
                    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    if (json["runId"] as? String) != runId { continue }
                    if let state = json["state"] as? String {
                        switch state {
                        case "final": return .final
                        case "aborted": return .aborted
                        case "error": return .error
                        default: break
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
        bridge: BridgeSession,
        since: Double,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await self.fetchLatestAssistantText(bridge: bridge, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(bridge: BridgeSession, since: Double? = nil) async throws -> String? {
        let res = try await bridge.request(
            method: "chat.history",
            paramsJSON: "{\"sessionKey\":\"\(self.mainSessionKey)\"}",
            timeoutSeconds: 15)
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
            if let since, let timestamp = msg["timestamp"] as? Double,
               TalkModeRuntime.isMessageTimestampAfter(timestamp, sinceSeconds: since) == false
            {
                continue
            }
            guard let content = msg["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private func playAssistant(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        let directive = parsed.directive
        let cleaned = parsed.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }

        if let voice = directive?.voiceId {
            if directive?.once != true {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
            }
        }
        if let model = directive?.modelId {
            if directive?.once != true {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }

        let voiceId = directive?.voiceId ?? self.currentVoiceId ?? self.defaultVoiceId
        guard let voiceId, !voiceId.isEmpty else {
            self.statusText = "Missing voice ID"
            self.logger.error("missing voiceId")
            return
        }

        let resolvedKey =
            (self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil) ??
            ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
        guard let apiKey = resolvedKey, !apiKey.isEmpty else {
            self.statusText = "Missing ELEVENLABS_API_KEY"
            self.logger.error("missing ELEVENLABS_API_KEY")
            return
        }

        self.statusText = "Generating voice…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned

        do {
            let started = Date()
            let desiredOutputFormat = directive?.outputFormat ?? self.defaultOutputFormat
            let outputFormat = TalkModeRuntime.validatedOutputFormat(desiredOutputFormat)
            if outputFormat == nil, let desiredOutputFormat, !desiredOutputFormat.isEmpty {
                self.logger.warning("talk output_format unsupported for local playback: \(desiredOutputFormat, privacy: .public)")
            }
            let request = ElevenLabsRequest(
                text: cleaned,
                modelId: directive?.modelId ?? self.currentModelId ?? self.defaultModelId,
                outputFormat: outputFormat,
                speed: TalkModeRuntime.resolveSpeed(
                    speed: directive?.speed,
                    rateWPM: directive?.rateWPM),
                stability: TalkModeRuntime.validatedUnit(directive?.stability),
                similarity: TalkModeRuntime.validatedUnit(directive?.similarity),
                style: TalkModeRuntime.validatedUnit(directive?.style),
                speakerBoost: directive?.speakerBoost,
                seed: TalkModeRuntime.validatedSeed(directive?.seed),
                normalize: TalkModeRuntime.validatedNormalize(directive?.normalize),
                language: TalkModeRuntime.validatedLanguage(directive?.language))

            let synthTimeoutSeconds = max(20.0, min(90.0, Double(cleaned.count) * 0.12))
            let client = ElevenLabsClient(apiKey: apiKey)
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
            self.logger
                .info(
                    "elevenlabs ok bytes=\(audio.count, privacy: .public) dur=\(Date().timeIntervalSince(started), privacy: .public)s")

            if self.interruptOnSpeech {
                do {
                    try self.startRecognition()
                } catch {
                    self.logger.warning("startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                }
            }

            self.statusText = "Speaking…"
            try await self.playAudio(data: audio)
        } catch {
            self.statusText = "Speak failed: \(error.localizedDescription)"
            self.logger.error("speak failed: \(error.localizedDescription, privacy: .public)")
        }

        self.stopRecognition()
        self.isSpeaking = false
    }

    private func playAudio(data: Data) async throws {
        self.player?.stop()
        let player = try AVAudioPlayer(data: data)
        self.player = player
        player.prepareToPlay()
        self.logger.info("play start")
        player.play()
        while player.isPlaying {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        self.logger.info("play done")
    }

    private func stopSpeaking(storeInterruption: Bool = true) {
        guard self.isSpeaking else { return }
        if storeInterruption {
            self.lastInterruptedAtSeconds = self.player?.currentTime
        }
        self.player?.stop()
        self.player = nil
        self.isSpeaking = false
    }

    private func shouldInterrupt(with transcript: String) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if let spoken = self.lastSpokenText?.lowercased(), spoken.contains(trimmed.lowercased()) {
            return false
        }
        return true
    }

    private func reloadConfig() async {
        guard let bridge else { return }
        do {
            let res = try await bridge.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let talk = config["talk"] as? [String: Any]
            let session = config["session"] as? [String: Any]
            let rawMainKey = (session?["mainKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            self.mainSessionKey = rawMainKey.isEmpty ? "main" : rawMainKey
            self.defaultVoiceId = (talk?["voiceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if !self.voiceOverrideActive {
                self.currentVoiceId = self.defaultVoiceId
            }
            self.defaultModelId = (talk?["modelId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
            self.defaultOutputFormat = (talk?["outputFormat"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.apiKey = (talk?["apiKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let interrupt = talk?["interruptOnSpeech"] as? Bool {
                self.interruptOnSpeech = interrupt
            }
        } catch {
            // ignore
        }
    }

    private static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [
            .duckOthers,
            .mixWithOthers,
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try session.setActive(true, options: [])
    }

    private nonisolated static func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            AVAudioApplication.requestRecordPermission { ok in
                cont.resume(returning: ok)
            }
        }
    }

    private nonisolated static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
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
    let baseUrl = URL(string: "https://api.elevenlabs.io")!

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
        if !voiceSettings.isEmpty { payload["voice_settings"] = voiceSettings }

        let body = try JSONSerialization.data(withJSONObject: payload, options: [])
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        req.timeoutInterval = 45
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

private enum TalkModeRuntime {
    static func resolveSpeed(speed: Double?, rateWPM: Int?) -> Double? {
        if let rateWPM, rateWPM > 0 {
            let resolved = Double(rateWPM) / 175.0
            if resolved <= 0.5 || resolved >= 2.0 { return nil }
            return resolved
        }
        if let speed {
            if speed <= 0.5 || speed >= 2.0 { return nil }
            return speed
        }
        return nil
    }

    static func validatedUnit(_ value: Double?) -> Double? {
        guard let value else { return nil }
        if value < 0 || value > 1 { return nil }
        return value
    }

    static func validatedSeed(_ value: Int?) -> UInt32? {
        guard let value else { return nil }
        if value < 0 || value > 4_294_967_295 { return nil }
        return UInt32(value)
    }

    static func validatedNormalize(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["auto", "on", "off"].contains(normalized) ? normalized : nil
    }

    static func validatedLanguage(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count == 2, normalized.allSatisfy({ $0 >= "a" && $0 <= "z" }) else { return nil }
        return normalized
    }

    static func validatedOutputFormat(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed.hasPrefix("mp3_") ? trimmed : nil
    }

    static func isMessageTimestampAfter(_ timestamp: Double, sinceSeconds: Double) -> Bool {
        let sinceMs = sinceSeconds * 1000
        if timestamp > 10_000_000_000 {
            return timestamp >= sinceMs - 500
        }
        return timestamp >= sinceSeconds - 0.5
    }
}
