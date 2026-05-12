#if canImport(AVFAudio)
import AVFAudio
#endif
#if canImport(AVFoundation)
import AVFoundation
#endif
import Foundation
import OpenClawProtocol
import OSLog

#if os(iOS)
import AVFoundation
#endif

public struct CanvasRealtimeTalkStatus: Sendable {
    public let ok: Bool
    public let state: String
    public let message: String?
    public let provider: String?
    public let model: String?
    public let voice: String?

    public init(
        ok: Bool,
        state: String,
        message: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        voice: String? = nil)
    {
        self.ok = ok
        self.state = state
        self.message = message
        self.provider = provider
        self.model = model
        self.voice = voice
    }
}

public actor CanvasRealtimeTalkBridge {
    public typealias RequestHandler = @Sendable (_ method: String, _ paramsJSON: String?, _ timeoutSeconds: Int) async throws -> Data
    public typealias EventStreamProvider = @Sendable () async -> AsyncStream<EventFrame>
    public typealias StatusHandler = @Sendable (CanvasRealtimeTalkStatus) async -> Void

    private struct SessionRequest: Encodable {
        let sessionKey: String?
        let mode: String
        let transport: String
        let brain: String
    }

    private struct RelayAudioContract: Decodable, Sendable {
        let inputEncoding: String
        let inputSampleRateHz: Int
        let outputEncoding: String
        let outputSampleRateHz: Int
    }

    private struct SessionResponse: Decodable, Sendable {
        let sessionId: String?
        let provider: String?
        let transport: String?
        let relaySessionId: String?
        let model: String?
        let voice: String?
        let audio: RelayAudioContract?
    }

    private struct ToolCallResponse: Decodable, Sendable {
        let runId: String?
        let idempotencyKey: String?
    }

    private struct ChatEventPayload: Decodable, Sendable {
        let runId: String?
        let state: String?
        let errorMessage: String?
        let message: AnyCodable?
    }

    fileprivate struct RelayTranscriptEvent: Sendable {
        let role: String
        let text: String
        let final: Bool
    }

    fileprivate struct RelayToolCallEvent: Sendable {
        let callId: String
        let name: String
        let args: AnyCodable?
    }

    private struct TranscriptEntry: Sendable {
        let role: String
        let text: String
    }

    private struct RelaySessionState: Sendable {
        let sessionId: String
        let relaySessionId: String
        let sessionKey: String?
        let provider: String
        let model: String?
        let voice: String?
        let inputSampleRateHz: Double
        let outputSampleRateHz: Double
    }

    private struct RelayOkResult: Decodable {
        let ok: Bool
    }

    struct CaptureHandle {
        let stop: () async -> Void
    }

    struct PlaybackHandle {
        let stop: () async -> Void
    }

    struct Runtime {
        let requestMicrophonePermission: () async -> Bool
        let configureAudioSession: () throws -> Void
        let startCapture: (_ sampleRate: Double, _ onChunk: @escaping @Sendable (Data) async -> Void) throws -> CaptureHandle
        let startPlayback: (_ sampleRate: Double, _ stream: AsyncThrowingStream<Data, Error>) async -> PlaybackHandle

        static func live() -> Runtime {
            Runtime(
                requestMicrophonePermission: {
                    await CanvasRealtimeTalkBridge.requestMicrophonePermission()
                },
                configureAudioSession: {
                    #if os(iOS)
                    try CanvasRealtimeTalkBridge.configureAudioSession()
                    #endif
                },
                startCapture: { sampleRate, onChunk in
                    try CanvasRealtimeTalkBridge.makeLiveCaptureHandle(
                        sampleRate: sampleRate,
                        onChunk: onChunk)
                },
                startPlayback: { sampleRate, stream in
                    await CanvasRealtimeTalkBridge.makeLivePlaybackHandle(
                        sampleRate: sampleRate,
                        stream: stream)
                })
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "canvas.realtime")
    private let request: RequestHandler
    private let events: EventStreamProvider
    private let onStatus: StatusHandler?
    private let runtime: Runtime
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var session: RelaySessionState?
    private var eventTask: Task<Void, Never>?
    private var playbackHandle: PlaybackHandle?
    private var playbackContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var captureHandle: CaptureHandle?
    private var transcriptEntries: [TranscriptEntry] = []
    private var outputCursorUptime: TimeInterval = 0
    private var currentState: String = "idle"

    public init(
        request: @escaping RequestHandler,
        events: @escaping EventStreamProvider,
        onStatus: StatusHandler? = nil)
    {
        self.request = request
        self.events = events
        self.onStatus = onStatus
        self.runtime = Runtime.live()
    }

    init(
        request: @escaping RequestHandler,
        events: @escaping EventStreamProvider,
        onStatus: StatusHandler? = nil,
        runtime: Runtime)
    {
        self.request = request
        self.events = events
        self.onStatus = onStatus
        self.runtime = runtime
    }

    public func isActive() -> Bool {
        self.session != nil
    }

    public func toggle(sessionKey: String?) async -> CanvasRealtimeTalkStatus {
        if self.session != nil {
            return await self.stop(message: "Dedicated realtime bridge stopped.")
        }
        return await self.start(sessionKey: sessionKey)
    }

    public func start(sessionKey: String?) async -> CanvasRealtimeTalkStatus {
        if let session = self.session {
            let status = CanvasRealtimeTalkStatus(
                ok: true,
                state: self.currentState,
                message: "Dedicated realtime bridge already active.",
                provider: session.provider,
                model: session.model,
                voice: session.voice)
            await self.emit(status)
            return status
        }

        let permissionOk = await self.runtime.requestMicrophonePermission()
        guard permissionOk else {
            let status = CanvasRealtimeTalkStatus(
                ok: false,
                state: "error",
                message: "Microphone permission is required for realtime talk.")
            await self.emit(status)
            return status
        }

        do {
            try self.runtime.configureAudioSession()

            let payload = try self.encoder.encode(SessionRequest(
                sessionKey: sessionKey,
                mode: "realtime",
                transport: "gateway-relay",
                brain: "agent-consult"))
            let responseData = try await self.request(
                "talk.session.create",
                String(decoding: payload, as: UTF8.self),
                20)
            let response = try self.decoder.decode(SessionResponse.self, from: responseData)
            let sessionId = Self.trimmedNonEmpty(response.sessionId) ?? Self.trimmedNonEmpty(response.relaySessionId)
            let relaySessionId = Self.trimmedNonEmpty(response.relaySessionId) ?? sessionId

            guard response.transport == "gateway-relay",
                  let sessionId,
                  let relaySessionId,
                  let audio = response.audio,
                  audio.inputEncoding == "pcm16",
                  audio.outputEncoding == "pcm16"
            else {
                let transport = response.transport?.trimmingCharacters(in: .whitespacesAndNewlines)
                let message = transport == "webrtc-sdp"
                    ? "Gateway returned a WebRTC browser session. The native relay bridge is not available yet for this connection."
                    : "Gateway did not return a relay-capable realtime session."
                let status = CanvasRealtimeTalkStatus(
                    ok: false,
                    state: "setup",
                    message: message,
                    provider: response.provider,
                    model: response.model,
                    voice: response.voice)
                await self.emit(status)
                return status
            }

            let relaySession = RelaySessionState(
                sessionId: sessionId,
                relaySessionId: relaySessionId,
                sessionKey: sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
                provider: response.provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "openai",
                model: response.model?.trimmingCharacters(in: .whitespacesAndNewlines),
                voice: response.voice?.trimmingCharacters(in: .whitespacesAndNewlines),
                inputSampleRateHz: Double(audio.inputSampleRateHz),
                outputSampleRateHz: Double(audio.outputSampleRateHz))
            self.session = relaySession
            self.transcriptEntries.removeAll(keepingCapacity: true)
            self.outputCursorUptime = ProcessInfo.processInfo.systemUptime
            self.startEventLoop(relaySessionId: relaySessionId)
            await self.startPlayback(sampleRate: relaySession.outputSampleRateHz)
            try await self.startCapture(sampleRate: relaySession.inputSampleRateHz)

            let status = CanvasRealtimeTalkStatus(
                ok: true,
                state: "active",
                message: "Dedicated realtime bridge connected.",
                provider: relaySession.provider,
                model: relaySession.model,
                voice: relaySession.voice)
            await self.emit(status)
            return status
        } catch {
            await self.stopInternally(sendStopRequest: false)
            let status = CanvasRealtimeTalkStatus(
                ok: false,
                state: "error",
                message: error.localizedDescription)
            await self.emit(status)
            return status
        }
    }

    public func stop(message: String? = nil) async -> CanvasRealtimeTalkStatus {
        let provider = self.session?.provider
        let model = self.session?.model
        let voice = self.session?.voice
        await self.stopInternally(sendStopRequest: true)
        let status = CanvasRealtimeTalkStatus(
            ok: true,
            state: "idle",
            message: message ?? "Dedicated realtime bridge is idle.",
            provider: provider,
            model: model,
            voice: voice)
        await self.emit(status)
        return status
    }

    private func emit(_ status: CanvasRealtimeTalkStatus) async {
        self.currentState = status.state
        await self.onStatus?(status)
    }

    private func startEventLoop(relaySessionId: String) {
        self.eventTask?.cancel()
        let provider = self.events
        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await provider()
            for await event in stream {
                if Task.isCancelled {
                    break
                }
                await self.handle(eventFrame: event, relaySessionId: relaySessionId)
            }
        }
    }

    private func handle(eventFrame: EventFrame, relaySessionId: String) async {
        guard eventFrame.event == "talk.event" || eventFrame.event == "talk.realtime.relay",
              let payload = eventFrame.payload
        else {
            return
        }
        guard let event = self.decodeRelayEvent(payload), event.relaySessionId == relaySessionId else {
            return
        }

        switch event.kind {
        case .ready:
            await self.emitCurrentState(
                state: "listening",
                message: "Thomas is live and listening.")
        case let .audio(audioBase64):
            guard let data = Data(base64Encoded: audioBase64), !data.isEmpty else { return }
            self.queueOutput(data)
            self.playbackContinuation?.yield(data)
            await self.emitCurrentState(
                state: "speaking",
                message: "Thomas is speaking in realtime.")
        case .clear:
            await self.clearOutput()
            await self.emitCurrentState(
                state: "listening",
                message: "Thomas cleared the current phrase.")
        case .mark:
            return
        case let .transcript(entry):
            self.handleTranscript(entry)
            let prefix = entry.role == "assistant" ? "Thomas" : "You"
            await self.emitCurrentState(
                state: entry.role == "assistant" ? "speaking" : "thinking",
                message: "\(prefix): \(entry.text)")
        case let .toolCall(call):
            await self.handleToolCall(call, relaySessionId: relaySessionId)
        case let .error(message):
            await self.emitCurrentState(state: "error", message: message)
            await self.stopInternally(sendStopRequest: false)
        case .close:
            _ = await self.stop(message: "Realtime session closed.")
        }
    }

    private func emitCurrentState(state: String, message: String?) async {
        let provider = self.session?.provider
        let model = self.session?.model
        let voice = self.session?.voice
        await self.emit(
            CanvasRealtimeTalkStatus(
                ok: state != "error",
                state: state,
                message: message,
                provider: provider,
                model: model,
                voice: voice))
    }

    private func startPlayback(sampleRate: Double) async {
        self.playbackContinuation?.finish()
        self.playbackContinuation = nil
        if let handle = self.playbackHandle {
            await handle.stop()
        }
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.playbackContinuation = continuation
        }
        self.playbackHandle = await self.runtime.startPlayback(sampleRate, stream)
    }

    private func startCapture(sampleRate: Double) async throws {
        if let handle = self.captureHandle {
            await handle.stop()
        }
        self.captureHandle = try self.runtime.startCapture(sampleRate) { [weak self] data in
            await self?.sendAudioChunk(data)
        }
    }

    private func sendAudioChunk(_ data: Data) async {
        guard let session = self.session else { return }
        let payload: [String: Any] = [
            "sessionId": session.sessionId,
            "audioBase64": data.base64EncodedString(),
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]
        do {
            _ = try await self.request(
                "talk.session.appendAudio",
                Self.jsonString(from: payload),
                10)
        } catch {
            self.logger.error("realtime relay audio failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func queueOutput(_ data: Data) {
        let now = ProcessInfo.processInfo.systemUptime
        let startAt = max(now, self.outputCursorUptime)
        let sampleRate = max(1, self.session?.outputSampleRateHz ?? 24_000)
        let sampleCount = Double(data.count) / 2.0
        let duration = sampleCount / sampleRate
        self.outputCursorUptime = startAt + duration
    }

    private func clearOutput() async {
        self.outputCursorUptime = ProcessInfo.processInfo.systemUptime
        self.playbackContinuation?.finish()
        self.playbackContinuation = nil
        if let handle = self.playbackHandle {
            await handle.stop()
            self.playbackHandle = nil
        }
        if let sampleRate = self.session?.outputSampleRateHz {
            await self.startPlayback(sampleRate: sampleRate)
        }
    }

    private func handleTranscript(_ entry: RelayTranscriptEvent) {
        let trimmed = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if entry.final {
            self.transcriptEntries.append(TranscriptEntry(role: entry.role, text: trimmed))
            if self.transcriptEntries.count > 12 {
                self.transcriptEntries.removeFirst(self.transcriptEntries.count - 12)
            }
        }
    }

    private func handleToolCall(_ call: RelayToolCallEvent, relaySessionId: String) async {
        guard call.name == "openclaw_agent_consult" else {
            await self.submitToolResult(
                sessionId: self.session?.sessionId ?? relaySessionId,
                callId: call.callId,
                result: ["error": "Tool \"\(call.name)\" is not available in native realtime talk."])
            return
        }

        do {
            let payload = Self.toolCallPayload(
                sessionKey: self.session?.sessionKey,
                callId: call.callId,
                relaySessionId: relaySessionId,
                args: call.args?.foundationValue)
            let data = try await self.request(
                "talk.client.toolCall",
                Self.jsonString(from: payload),
                45)
            let response = try self.decoder.decode(ToolCallResponse.self, from: data)
            let runId = Self.trimmedNonEmpty(response.runId) ?? Self.trimmedNonEmpty(response.idempotencyKey)
            guard let runId else {
                throw NSError(
                    domain: "CanvasRealtimeTalkBridge",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "OpenClaw realtime tool call did not return a run id"])
            }
            let result = try await self.waitForChatResult(runId: runId, timeoutSeconds: 120)
            await self.submitToolResult(
                sessionId: self.session?.sessionId ?? relaySessionId,
                callId: call.callId,
                result: ["result": result])
        } catch {
            await self.submitToolResult(
                sessionId: self.session?.sessionId ?? relaySessionId,
                callId: call.callId,
                result: ["error": error.localizedDescription])
        }
    }

    static func consultPayload(
        sessionKey: String?,
        args: Any?,
        transcript: [[String: String]])
        -> [String: Any]
    {
        var payload: [String: Any] = [:]
        let trimmedSessionKey = sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedSessionKey.isEmpty {
            payload["sessionKey"] = trimmedSessionKey
        }
        if let args {
            payload["args"] = args
        }
        if !transcript.isEmpty {
            payload["transcript"] = transcript
        }
        return payload
    }

    private static func toolCallPayload(
        sessionKey: String?,
        callId: String,
        relaySessionId: String,
        args: Any?)
        -> [String: Any]
    {
        var payload: [String: Any] = [
            "callId": callId,
            "name": "openclaw_agent_consult",
            "relaySessionId": relaySessionId,
            "args": args ?? [:],
        ]
        let trimmedSessionKey = sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedSessionKey.isEmpty {
            payload["sessionKey"] = trimmedSessionKey
        }
        return payload
    }

    private func waitForChatResult(runId: String, timeoutSeconds: Double) async throws -> String {
        let stream = await self.events()
        return try await AsyncTimeout.withTimeout(
            seconds: timeoutSeconds,
            onTimeout: {
                NSError(
                    domain: "CanvasRealtimeTalkBridge",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "OpenClaw tool call timed out"])
            },
            operation: {
                for await event in stream {
                    guard event.event == "chat",
                          let payload = event.payload,
                          let chatPayload = try? GatewayPayloadDecoding.decode(payload, as: ChatEventPayload.self),
                          chatPayload.runId == runId
                    else {
                        continue
                    }

                    switch chatPayload.state?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                    case "final":
                        return Self.extractTextFromChatMessage(chatPayload.message) ?? "OpenClaw finished with no text."
                    case "aborted":
                        throw NSError(
                            domain: "CanvasRealtimeTalkBridge",
                            code: 4,
                            userInfo: [NSLocalizedDescriptionKey: chatPayload.errorMessage ?? "OpenClaw tool call aborted"])
                    case "error":
                        throw NSError(
                            domain: "CanvasRealtimeTalkBridge",
                            code: 5,
                            userInfo: [NSLocalizedDescriptionKey: chatPayload.errorMessage ?? "OpenClaw tool call failed"])
                    default:
                        continue
                    }
                }

                throw NSError(
                    domain: "CanvasRealtimeTalkBridge",
                    code: 6,
                    userInfo: [NSLocalizedDescriptionKey: "OpenClaw tool call finished without a final chat event"])
            })
    }

    private static func extractTextFromChatMessage(_ message: AnyCodable?) -> String? {
        guard let message else { return nil }
        guard let dict = message.dictionaryValue else { return nil }

        if let text = dict["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty
        {
            return text
        }

        guard let content = dict["content"]?.arrayValue else { return nil }
        let parts = content.compactMap { item -> String? in
            guard let block = item.dictionaryValue,
                  block["type"]?.stringValue == "text",
                  let text = block["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty
            else {
                return nil
            }
            return text
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    private static func trimmedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func submitToolResult(sessionId: String, callId: String, result: [String: Any]) async {
        let payload: [String: Any] = [
            "sessionId": sessionId,
            "callId": callId,
            "result": result,
        ]
        do {
            let data = try await self.request(
                "talk.session.submitToolResult",
                Self.jsonString(from: payload),
                30)
            _ = try? self.decoder.decode(RelayOkResult.self, from: data)
        } catch {
            self.logger.error("realtime tool result failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopInternally(sendStopRequest: Bool) async {
        let sessionId = self.session?.sessionId
        self.eventTask?.cancel()
        self.eventTask = nil
        if let handle = self.captureHandle {
            await handle.stop()
            self.captureHandle = nil
        }
        await self.clearOutput()
        self.transcriptEntries.removeAll(keepingCapacity: false)
        self.session = nil

        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        #endif

        guard sendStopRequest, let sessionId else { return }
        let payload: [String: Any] = [
            "sessionId": sessionId,
        ]
        do {
            _ = try await self.request("talk.session.close", Self.jsonString(from: payload), 10)
        } catch {
            self.logger.error("realtime relay stop failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func decodeRelayEvent(_ payload: AnyCodable) -> RelayEvent? {
        guard let dict = payload.dictionaryValue,
              (dict["relaySessionId"]?.stringValue?.isEmpty == false ||
                  dict["sessionId"]?.stringValue?.isEmpty == false),
              let type = dict["type"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return nil
        }
        let relaySessionId = dict["relaySessionId"]?.stringValue ?? dict["sessionId"]?.stringValue ?? ""
        switch type {
        case "ready":
            return RelayEvent(relaySessionId: relaySessionId, kind: .ready)
        case "audio":
            guard let audioBase64 = dict["audioBase64"]?.stringValue else { return nil }
            return RelayEvent(relaySessionId: relaySessionId, kind: .audio(audioBase64))
        case "clear":
            return RelayEvent(relaySessionId: relaySessionId, kind: .clear)
        case "mark":
            return RelayEvent(relaySessionId: relaySessionId, kind: .mark)
        case "transcript":
            guard let role = dict["role"]?.stringValue,
                  let text = dict["text"]?.stringValue
            else {
                return nil
            }
            return RelayEvent(
                relaySessionId: relaySessionId,
                kind: .transcript(
                    RelayTranscriptEvent(
                        role: role,
                        text: text,
                        final: dict["final"]?.boolValue ?? false)))
        case "toolCall":
            guard let callId = dict["callId"]?.stringValue,
                  let name = dict["name"]?.stringValue
            else {
                return nil
            }
            return RelayEvent(
                relaySessionId: relaySessionId,
                kind: .toolCall(
                    RelayToolCallEvent(
                        callId: callId,
                        name: name,
                        args: dict["args"])))
        case "error":
            return RelayEvent(
                relaySessionId: relaySessionId,
                kind: .error(dict["message"]?.stringValue ?? "Realtime relay failed."))
        case "close":
            return RelayEvent(relaySessionId: relaySessionId, kind: .close)
        default:
            return nil
        }
    }

    private static func jsonString(from payload: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    #if os(iOS)
    private static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try? session.setPreferredSampleRate(48000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
    }
    #endif

    private static func requestMicrophonePermission() async -> Bool {
        #if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { ok in
                    continuation.resume(returning: ok)
                }
            }
        @unknown default:
            return false
        }
        #elseif canImport(AVFoundation)
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    continuation.resume(returning: ok)
                }
            }
        @unknown default:
            return false
        }
        #else
        return true
        #endif
    }

    private static func makeLiveCaptureHandle(
        sampleRate: Double,
        onChunk: @escaping @Sendable (Data) async -> Void) throws -> CaptureHandle
    {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let encoder = try RealtimePCM16Encoder(sourceFormat: format, targetSampleRate: sampleRate)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            guard let data = encoder.encode(buffer), !data.isEmpty else { return }
            Task {
                await onChunk(data)
            }
        }
        engine.prepare()
        try engine.start()
        return CaptureHandle {
            input.removeTap(onBus: 0)
            engine.stop()
        }
    }

    private static func makeLivePlaybackHandle(
        sampleRate: Double,
        stream: AsyncThrowingStream<Data, Error>) async -> PlaybackHandle
    {
        let task = Task { @MainActor in
            _ = await PCMStreamingAudioPlayer.shared.play(stream: stream, sampleRate: sampleRate)
        }
        return PlaybackHandle {
            task.cancel()
            await MainActor.run {
                _ = PCMStreamingAudioPlayer.shared.stop()
            }
        }
    }
}

private struct RelayEvent: Sendable {
    enum Kind: Sendable {
        case ready
        case audio(String)
        case clear
        case mark
        case transcript(CanvasRealtimeTalkBridge.RelayTranscriptEvent)
        case toolCall(CanvasRealtimeTalkBridge.RelayToolCallEvent)
        case error(String)
        case close
    }

    let relaySessionId: String
    let kind: Kind
}

private final class RealtimePCM16Encoder: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let targetFormat: AVAudioFormat
    private let lock = NSLock()

    init(sourceFormat: AVAudioFormat, targetSampleRate: Double) throws {
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true),
            let converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
        else {
            throw NSError(
                domain: "CanvasRealtimeTalkBridge",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to configure realtime audio converter"])
        }
        self.converter = converter
        self.targetFormat = targetFormat
    }

    func encode(_ buffer: AVAudioPCMBuffer) -> Data? {
        self.lock.lock()
        defer { self.lock.unlock() }

        let frameCapacity = AVAudioFrameCount(
            max(
                1,
                ceil(Double(buffer.frameLength) * self.targetFormat.sampleRate / buffer.format.sampleRate)))
        guard let output = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: frameCapacity) else {
            return nil
        }

        let input = ConverterInput(buffer)
        var error: NSError?
        let status = self.converter.convert(to: output, error: &error) { _, outStatus in
            if input.didProvide {
                outStatus.pointee = .noDataNow
                return nil
            }
            input.didProvide = true
            outStatus.pointee = .haveData
            return input.buffer
        }

        guard status != .error,
              let mData = output.audioBufferList.pointee.mBuffers.mData
        else {
            return nil
        }
        return Data(bytes: mData, count: Int(output.audioBufferList.pointee.mBuffers.mDataByteSize))
    }

    private final class ConverterInput: @unchecked Sendable {
        let buffer: AVAudioPCMBuffer
        var didProvide = false

        init(_ buffer: AVAudioPCMBuffer) {
            self.buffer = buffer
        }
    }
}
