import AVFAudio
import ClawdisKit
import Foundation
import Observation
import Speech

@MainActor
@Observable
final class TalkModeManager: NSObject {
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
    private var defaultOutputFormat: String?
    private var interruptOnSpeech: Bool = true

    private var bridge: BridgeSession?
    private let silenceWindow: TimeInterval = 0.7

    private var player: AVAudioPlayer?

    func attachBridge(_ bridge: BridgeSession) {
        self.bridge = bridge
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            Task { await self.start() }
        } else {
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }

        self.statusText = "Requesting permissions…"
        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.statusText = "Microphone permission denied"
            return
        }
        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
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
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
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
    }

    private func startRecognition() throws {
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
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        self.audioEngine.prepare()
        try self.audioEngine.start()

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                self.statusText = "Speech error: \(error.localizedDescription)"
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
        guard self.isListening else { return }
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
            await self.start()
            return
        }

        do {
            let runId = try await self.sendChat(prompt, bridge: bridge)
            let ok = await self.waitForChatFinal(runId: runId, bridge: bridge)
            if !ok {
                self.statusText = "No reply"
                await self.start()
                return
            }

            guard let assistantText = try await self.fetchLatestAssistantText(bridge: bridge) else {
                self.statusText = "No reply"
                await self.start()
                return
            }
            await self.playAssistant(text: assistantText)
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
        }

        await self.start()
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

    private func sendChat(_ message: String, bridge: BridgeSession) async throws -> String {
        struct SendResponse: Decodable { let runId: String }
        let payload: [String: Any] = [
            "sessionKey": "main",
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

    private func waitForChatFinal(runId: String, bridge: BridgeSession) async -> Bool {
        let stream = await bridge.subscribeServerEvents(bufferingNewest: 200)
        let timeout = Date().addingTimeInterval(120)
        for await evt in stream {
            if Date() > timeout { return false }
            guard evt.event == "chat", let payload = evt.payloadJSON else { continue }
            guard let data = payload.data(using: .utf8) else { continue }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if (json["runId"] as? String) != runId { continue }
            if let state = json["state"] as? String, state == "final" {
                return true
            }
        }
        return false
    }

    private func fetchLatestAssistantText(bridge: BridgeSession) async throws -> String? {
        let res = try await bridge.request(
            method: "chat.history",
            paramsJSON: "{\"sessionKey\":\"main\"}",
            timeoutSeconds: 15)
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
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
            }
        }
        if let model = directive?.modelId {
            if directive?.once != true {
                self.currentModelId = model
            }
        }

        let voiceId = directive?.voiceId ?? self.currentVoiceId ?? self.defaultVoiceId
        guard let voiceId, !voiceId.isEmpty else {
            self.statusText = "Missing voice ID"
            return
        }

        guard let apiKey = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"], !apiKey.isEmpty else {
            self.statusText = "Missing ELEVENLABS_API_KEY"
            return
        }

        self.statusText = "Speaking…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned

        do {
            let request = ElevenLabsRequest(
                text: cleaned,
                modelId: directive?.modelId ?? self.currentModelId ?? self.defaultModelId,
                outputFormat: directive?.outputFormat ?? self.defaultOutputFormat,
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
            let audio = try await ElevenLabsClient(apiKey: apiKey).synthesize(
                voiceId: voiceId,
                request: request)
            try await self.playAudio(data: audio)
        } catch {
            self.statusText = "Speak failed: \(error.localizedDescription)"
        }

        self.isSpeaking = false
    }

    private func playAudio(data: Data) async throws {
        self.player?.stop()
        let player = try AVAudioPlayer(data: data)
        self.player = player
        player.prepareToPlay()
        player.play()
        while player.isPlaying {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    private func stopSpeaking() {
        guard self.isSpeaking else { return }
        self.lastInterruptedAtSeconds = self.player?.currentTime
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
            self.defaultVoiceId = (talk?["voiceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.currentVoiceId = self.defaultVoiceId
            self.defaultModelId = (talk?["modelId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.currentModelId = self.defaultModelId
            self.defaultOutputFormat = (talk?["outputFormat"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
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
}
