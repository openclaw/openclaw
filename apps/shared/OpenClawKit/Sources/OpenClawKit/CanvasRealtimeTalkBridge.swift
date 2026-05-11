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
        let transport: String
    }

    private struct RelayAudioContract: Decodable, Sendable {
        let inputEncoding: String
        let inputSampleRateHz: Int
        let outputEncoding: String
        let outputSampleRateHz: Int
    }

    private struct SessionResponse: Decodable, Sendable {
        let provider: String?
        let transport: String?
        let relaySessionId: String?
        let model: String?
        let voice: String?
        let audio: RelayAudioContract?
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

    private struct RelayConsultResult: Decodable {
        let result: String
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "canvas.realtime")
    private let request: RequestHandler
    private let events: EventStreamProvider
    private let onStatus: StatusHandler?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var session: RelaySessionState?
    private var eventTask: Task<Void, Never>?
    private var playbackTask: Task<Void, Never>?
    private var playbackContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var inputEngine: AVAudioEngine?
    private var inputEncoder: RealtimePCM16Encoder?
    private var scheduledMarkTasks: [UUID: Task<Void, Never>] = [:]
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

        let permissionOk = await Self.requestMicrophonePermission()
        guard permissionOk else {
            let status = CanvasRealtimeTalkStatus(
                ok: false,
                state: "error",
                message: "Microphone permission is required for realtime talk.")
            await self.emit(status)
            return status
        }

        do {
            #if os(iOS)
            try Self.configureAudioSession()
            #endif

            let payload = try self.encoder.encode(SessionRequest(sessionKey: sessionKey, transport: "gateway-relay"))
            let responseData = try await self.request(
                "talk.realtime.session",
                String(decoding: payload, as: UTF8.self),
                20)
            let response = try self.decoder.decode(SessionResponse.self, from: responseData)

            guard response.transport == "gateway-relay",
                  let relaySessionId = response.relaySessionId,
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
            self.startPlayback(sampleRate: relaySession.outputSampleRateHz)
            try self.startCapture(sampleRate: relaySession.inputSampleRateHz)

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
        guard eventFrame.event == "talk.realtime.relay",
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
            self.scheduleMarkAck(relaySessionId: relaySessionId)
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

    private func startPlayback(sampleRate: Double) {
        self.playbackContinuation?.finish()
        self.playbackTask?.cancel()
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.playbackContinuation = continuation
        }
        self.playbackTask = Task { @MainActor in
            _ = await PCMStreamingAudioPlayer.shared.play(stream: stream, sampleRate: sampleRate)
        }
    }

    private func startCapture(sampleRate: Double) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let encoder = try RealtimePCM16Encoder(sourceFormat: format, targetSampleRate: sampleRate)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self, let data = encoder.encode(buffer), !data.isEmpty else { return }
            Task {
                await self.sendAudioChunk(data)
            }
        }
        engine.prepare()
        try engine.start()
        self.inputEngine = engine
        self.inputEncoder = encoder
    }

    private func sendAudioChunk(_ data: Data) async {
        guard let session = self.session else { return }
        let payload: [String: Any] = [
            "relaySessionId": session.relaySessionId,
            "audioBase64": data.base64EncodedString(),
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]
        do {
            _ = try await self.request(
                "talk.realtime.relayAudio",
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
        self.cancelScheduledMarks()
        self.playbackContinuation?.finish()
        self.playbackContinuation = nil
        self.playbackTask?.cancel()
        self.playbackTask = nil
        await MainActor.run {
            _ = PCMStreamingAudioPlayer.shared.stop()
        }
        if let sampleRate = self.session?.outputSampleRateHz {
            self.startPlayback(sampleRate: sampleRate)
        }
    }

    private func scheduleMarkAck(relaySessionId: String) {
        let delay = max(0, self.outputCursorUptime - ProcessInfo.processInfo.systemUptime)
        let token = UUID()
        let task = Task { [weak self] in
            let nanoseconds = UInt64(delay * 1_000_000_000)
            if nanoseconds > 0 {
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
            guard !Task.isCancelled else { return }
            await self?.sendMark(relaySessionId: relaySessionId)
        }
        self.scheduledMarkTasks[token] = task
    }

    private func cancelScheduledMarks() {
        for task in self.scheduledMarkTasks.values {
            task.cancel()
        }
        self.scheduledMarkTasks.removeAll(keepingCapacity: false)
    }

    private func sendMark(relaySessionId: String) async {
        self.scheduledMarkTasks = self.scheduledMarkTasks.filter { !$0.value.isCancelled }
        let payload: [String: Any] = [
            "relaySessionId": relaySessionId,
        ]
        do {
            _ = try await self.request("talk.realtime.relayMark", Self.jsonString(from: payload), 10)
        } catch {
            self.logger.error("realtime relay mark failed: \(error.localizedDescription, privacy: .public)")
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
                relaySessionId: relaySessionId,
                callId: call.callId,
                result: ["error": "Tool \"\(call.name)\" is not available in native realtime talk."])
            return
        }

        do {
            let payload = Self.consultPayload(
                sessionKey: self.session?.sessionKey,
                args: call.args?.foundationValue,
                transcript: self.transcriptEntries.map { ["role": $0.role, "text": $0.text] })
            let data = try await self.request(
                "talk.realtime.consult",
                Self.jsonString(from: payload),
                45)
            let result = try self.decoder.decode(RelayConsultResult.self, from: data)
            await self.submitToolResult(
                relaySessionId: relaySessionId,
                callId: call.callId,
                result: ["result": result.result])
        } catch {
            await self.submitToolResult(
                relaySessionId: relaySessionId,
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

    private func submitToolResult(relaySessionId: String, callId: String, result: [String: Any]) async {
        let payload: [String: Any] = [
            "relaySessionId": relaySessionId,
            "callId": callId,
            "result": result,
        ]
        do {
            let data = try await self.request(
                "talk.realtime.relayToolResult",
                Self.jsonString(from: payload),
                30)
            _ = try? self.decoder.decode(RelayOkResult.self, from: data)
        } catch {
            self.logger.error("realtime tool result failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopInternally(sendStopRequest: Bool) async {
        let relaySessionId = self.session?.relaySessionId
        self.cancelScheduledMarks()
        self.eventTask?.cancel()
        self.eventTask = nil
        self.inputEngine?.inputNode.removeTap(onBus: 0)
        self.inputEngine?.stop()
        self.inputEngine = nil
        self.inputEncoder = nil
        await self.clearOutput()
        self.transcriptEntries.removeAll(keepingCapacity: false)
        self.session = nil

        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        #endif

        guard sendStopRequest, let relaySessionId else { return }
        let payload: [String: Any] = [
            "relaySessionId": relaySessionId,
        ]
        do {
            _ = try await self.request("talk.realtime.relayStop", Self.jsonString(from: payload), 10)
        } catch {
            self.logger.error("realtime relay stop failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func decodeRelayEvent(_ payload: AnyCodable) -> RelayEvent? {
        guard let dict = payload.dictionaryValue,
              dict["relaySessionId"]?.stringValue?.isEmpty == false,
              let type = dict["type"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return nil
        }
        let relaySessionId = dict["relaySessionId"]?.stringValue ?? ""
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
