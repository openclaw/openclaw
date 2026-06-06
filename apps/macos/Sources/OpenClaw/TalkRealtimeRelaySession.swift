import AVFoundation
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

private actor TalkRealtimeRelayAudioSender {
    private let client: TalkRealtimeRelayGatewayClient
    private var sessionId: String?
    private var pendingSends = 0
    private let maxPendingSends = 4

    init(client: TalkRealtimeRelayGatewayClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
    }

    func close() {
        self.sessionId = nil
    }

    func send(_ data: Data, timestampMs: Double) async -> String? {
        guard let sessionId else { return nil }
        guard self.pendingSends < self.maxPendingSends else { return nil }
        self.pendingSends += 1
        defer { self.pendingSends -= 1 }
        do {
            try await self.client.appendAudio(sessionId: sessionId, audio: data, timestampMs: timestampMs)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

@MainActor
final class TalkRealtimeRelaySession {
    private static let agentControlToolName = "openclaw_agent_control"
    private static let expectedInputEncoding = "pcm16"
    private static let expectedOutputEncoding = "pcm16"
    private static let defaultSampleRateHz = 24_000.0
    private static let audioFrameBufferSize: AVAudioFrameCount = 2_048
    private static let bargeInRMS: Float = 0.08

    private struct ChatCompletionResult {
        let text: String?
        let failed: Bool
    }

    private let client: TalkRealtimeRelayGatewayClient
    private let options: TalkRealtimeRelayOptions
    private let pcmPlayer: PCMStreamingAudioPlaying
    private let onPhaseChanged: @MainActor @Sendable (TalkModePhase) -> Void
    private let onLevelChanged: @MainActor @Sendable (Double) -> Void
    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime")

    private let audioEngine = AVAudioEngine()
    private var sessionId: String?
    private var inputSampleRateHz = TalkRealtimeRelaySession.defaultSampleRateHz
    private var outputSampleRateHz = TalkRealtimeRelaySession.defaultSampleRateHz
    private var audioSender: TalkRealtimeRelayAudioSender?
    private var eventTask: Task<Void, Never>?
    private var outputTask: Task<Void, Never>?
    private var outputContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var outputIdleTask: Task<Void, Never>?
    private var outputSessionId = 0
    private var pendingOutputChunks: [Data] = []
    private var pendingOutputDone = false
    private var isClosed = false
    private var isOutputPlaying = false
    private var outputPlaybackExpectedEndMs: Double = 0
    private var lastBargeInAtMs: Double = 0

    init(
        client: TalkRealtimeRelayGatewayClient = TalkRealtimeRelayGatewayClient(),
        options: TalkRealtimeRelayOptions,
        pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared,
        onPhaseChanged: @escaping @MainActor @Sendable (TalkModePhase) -> Void,
        onLevelChanged: @escaping @MainActor @Sendable (Double) -> Void)
    {
        self.client = client
        self.options = options
        self.pcmPlayer = pcmPlayer
        self.onPhaseChanged = onPhaseChanged
        self.onLevelChanged = onLevelChanged
    }

    func start() async throws {
        self.isClosed = false
        self.onPhaseChanged(.thinking)
        let result = try await self.client.createSession(options: self.options)
        guard let sessionId = result.relaysessionid?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty
        else {
            throw NSError(domain: "TalkRealtimeRelay", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Gateway did not return a realtime relay session",
            ])
        }
        self.sessionId = sessionId
        self.audioSender = TalkRealtimeRelayAudioSender(client: self.client, sessionId: sessionId)
        self.configureAudioContract(result.audio)
        let stream = await self.client.subscribe(bufferingNewest: 200)
        self.startEventPump(stream: stream)
        do {
            try self.startMicrophonePump()
            self.onPhaseChanged(.listening)
        } catch {
            self.stop(sendClose: false)
            await self.client.closeSession(sessionId: sessionId)
            throw error
        }
    }

    func stop() {
        self.stop(sendClose: true)
    }

    func cancelOutput(reason: String = "user") {
        self.stopOutputPlayback()
        guard let sessionId else { return }
        Task { [client] in
            await client.cancelOutput(sessionId: sessionId, reason: reason)
        }
    }

    private func stop(sendClose: Bool) {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.stopMicrophonePump()
        self.eventTask?.cancel()
        self.eventTask = nil
        let audioSender = self.audioSender
        self.audioSender = nil
        Task { await audioSender?.close() }
        self.stopOutputPlayback()
        self.onLevelChanged(0)
        if sendClose, let sessionId {
            Task { [client] in
                await client.closeSession(sessionId: sessionId)
            }
        }
        self.sessionId = nil
    }

    private func configureAudioContract(_ raw: AnyCodable?) {
        guard let audio = raw?.dictionaryValue else { return }
        let inputEncoding = audio["inputEncoding"]?.stringValue ?? Self.expectedInputEncoding
        let outputEncoding = audio["outputEncoding"]?.stringValue ?? Self.expectedOutputEncoding
        if inputEncoding != Self.expectedInputEncoding || outputEncoding != Self.expectedOutputEncoding {
            self.logger.warning(
                "unexpected realtime audio contract input=\(inputEncoding, privacy: .public) " +
                    "output=\(outputEncoding, privacy: .public)")
        }
        self.inputSampleRateHz = audio["inputSampleRateHz"]?.doubleValue ?? Self.defaultSampleRateHz
        self.outputSampleRateHz = audio["outputSampleRateHz"]?.doubleValue ?? Self.defaultSampleRateHz
    }

    private func startEventPump(stream: AsyncStream<GatewayPush>) {
        self.eventTask?.cancel()
        self.eventTask = Task { [weak self] in
            for await push in stream {
                if Task.isCancelled { return }
                guard case let .event(event) = push else { continue }
                await MainActor.run {
                    self?.handleGatewayEvent(event)
                }
            }
        }
    }

    private func handleGatewayEvent(_ event: EventFrame) {
        guard event.event == "talk.event",
              let payload = event.payload?.dictionaryValue,
              self.eventMatchesCurrentSession(payload),
              let type = payload["type"]?.stringValue
        else { return }

        switch type {
        case "ready":
            self.onPhaseChanged(.listening)
        case "audio":
            self.handleAudioEvent(payload)
        case "audioDone":
            self.finishOutputPlaybackStream()
        case "clear":
            self.stopOutputPlayback()
        case "transcript":
            self.handleTranscriptEvent(payload)
        case "toolCall":
            Task { await self.handleToolCall(payload) }
        case "error":
            let message = payload["message"]?.stringValue ?? "Realtime failed"
            self.logger.error("realtime event error: \(Self.safeLogMessage(message), privacy: .public)")
            self.onPhaseChanged(.listening)
        case "close":
            self.stop(sendClose: false)
            self.onPhaseChanged(.idle)
        default:
            return
        }
    }

    private func eventMatchesCurrentSession(_ payload: [String: AnyCodable]) -> Bool {
        guard let sessionId else { return false }
        let incoming = payload["relaySessionId"]?.stringValue ?? payload["sessionId"]?.stringValue
        guard let incoming else { return true }
        return incoming == sessionId
    }

    private func handleAudioEvent(_ payload: [String: AnyCodable]) {
        guard let base64 = payload["audioBase64"]?.stringValue,
              let data = Data(base64Encoded: base64),
              !data.isEmpty
        else { return }
        self.markOutputAudioStarted(byteCount: data.count, nowMs: ProcessInfo.processInfo.systemUptime * 1000)
        self.onPhaseChanged(.speaking)
        if self.outputContinuation == nil, self.outputTask != nil {
            self.pendingOutputChunks.append(data)
            return
        }
        self.ensureOutputPlaybackStarted()
        self.outputContinuation?.yield(data)
    }

    private func handleTranscriptEvent(_ payload: [String: AnyCodable]) {
        guard payload["final"]?.boolValue == true else { return }
        switch payload["role"]?.stringValue {
        case "user":
            self.onPhaseChanged(.thinking)
        case "assistant":
            self.onPhaseChanged(.listening)
        default:
            break
        }
    }

    private func handleToolCall(_ payload: [String: AnyCodable]) async {
        guard let sessionId,
              let callId = payload["callId"]?.stringValue,
              let name = payload["name"]?.stringValue
        else { return }
        self.onPhaseChanged(.thinking)
        do {
            if name == Self.agentControlToolName {
                try await self.handleAgentControlToolCall(
                    sessionId: sessionId,
                    callId: callId,
                    args: payload["args"])
                return
            }
            let completionStream = await self.client.subscribe(bufferingNewest: 200)
            let started = try await self.client.startToolCall(
                sessionKey: self.options.sessionKey,
                sessionId: sessionId,
                callId: callId,
                name: name,
                args: payload["args"]?.foundationValue ?? [:])
            guard let runId = started.runId ?? started.idempotencyKey else {
                throw NSError(domain: "TalkRealtimeRelay", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Realtime tool call did not return a run id",
                ])
            }
            let completion = await self.waitForChatCompletion(
                runId: runId,
                stream: completionStream,
                timeoutSeconds: 120)
            let result: [String: Any] = completion.failed
                ? ["error": "OpenClaw tool call failed"]
                : ["text": completion.text ?? "OpenClaw finished with no text."]
            try await self.client.submitToolResult(sessionId: sessionId, callId: callId, result: result)
            self.onPhaseChanged(.listening)
        } catch {
            try? await self.client.submitToolResult(
                sessionId: sessionId,
                callId: callId,
                result: ["error": error.localizedDescription])
            self.onPhaseChanged(.listening)
        }
    }

    private func handleAgentControlToolCall(
        sessionId: String,
        callId: String,
        args: AnyCodable?) async throws
    {
        let controlArgs = args?.dictionaryValue ?? [:]
        let text = controlArgs["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let mode = controlArgs["mode"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let response = try await self.client.steer(
            sessionId: sessionId,
            sessionKey: self.options.sessionKey,
            text: text?.isEmpty == false ? text! : "status",
            mode: mode?.isEmpty == false ? mode : nil)
        let result = response.dictionaryValue?.mapValues(\.foundationValue) ?? ["result": response.foundationValue]
        try await self.client.submitToolResult(sessionId: sessionId, callId: callId, result: result)
        self.onPhaseChanged(.listening)
    }

    private func waitForChatCompletion(
        runId: String,
        stream: AsyncStream<GatewayPush>,
        timeoutSeconds: Int) async -> ChatCompletionResult
    {
        await withTaskGroup(of: ChatCompletionResult.self) { group in
            group.addTask {
                for await push in stream {
                    if Task.isCancelled {
                        return ChatCompletionResult(text: nil, failed: true)
                    }
                    guard case let .event(event) = push,
                          event.event == "chat",
                          let payload = event.payload,
                          let chatEvent = try? GatewayPayloadDecoding.decode(
                              payload,
                              as: OpenClawChatEventPayload.self),
                          chatEvent.runId == runId
                    else { continue }
                    if chatEvent.state == "final" {
                        return ChatCompletionResult(
                            text: OpenClawChatEventText.assistantText(from: chatEvent),
                            failed: false)
                    }
                    if chatEvent.state == "aborted" || chatEvent.state == "error" {
                        return ChatCompletionResult(text: nil, failed: true)
                    }
                }
                return ChatCompletionResult(text: nil, failed: true)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return ChatCompletionResult(text: nil, failed: true)
            }
            let result = await group.next() ?? ChatCompletionResult(text: nil, failed: true)
            group.cancelAll()
            return result
        }
    }

    private func startMicrophonePump() throws {
        self.stopMicrophonePump()
        let input = self.audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkRealtimeRelay", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid realtime audio input format",
            ])
        }
        let targetSampleRate = self.inputSampleRateHz
        let audioSender = self.audioSender
        input.installTap(onBus: 0, bufferSize: Self.audioFrameBufferSize, format: format) {
            [weak self, audioSender] buffer, _ in
            let encoded = Self.encodePCM16(
                buffer: buffer,
                inputSampleRate: format.sampleRate,
                targetSampleRate: targetSampleRate)
            guard !encoded.isEmpty else { return }
            let rms = Self.rmsLevel(buffer: buffer)
            let timestampMs = (ProcessInfo.processInfo.systemUptime * 1000).rounded()
            Task {
                let shouldSend = await MainActor.run { [weak self] in
                    guard let self, !self.isClosed else { return false }
                    self.onLevelChanged(min(1, Double(rms / Self.bargeInRMS)))
                    if self.isOutputPlaying {
                        if self.options.interruptOnSpeech,
                           rms >= Self.bargeInRMS,
                           timestampMs - self.lastBargeInAtMs >= 900
                        {
                            self.lastBargeInAtMs = timestampMs
                            self.cancelOutput(reason: "barge-in")
                        }
                        return false
                    }
                    return true
                }
                guard shouldSend, let audioSender else { return }
                guard let message = await audioSender.send(encoded, timestampMs: timestampMs) else { return }
                await MainActor.run { [weak self] in
                    self?.logger.error(
                        "realtime append audio failed: \(Self.safeLogMessage(message), privacy: .public)")
                }
            }
        }
        self.audioEngine.prepare()
        try self.audioEngine.start()
    }

    private func stopMicrophonePump() {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
    }

    private func ensureOutputPlaybackStarted() {
        guard self.outputContinuation == nil, self.outputTask == nil else { return }
        self.outputSessionId += 1
        let sessionId = self.outputSessionId
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.outputContinuation = continuation
        }
        self.outputTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.pcmPlayer.play(stream: stream, sampleRate: self.outputSampleRateHz)
            await MainActor.run {
                guard self.outputSessionId == sessionId else { return }
                self.outputTask = nil
                self.outputContinuation = nil
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.logger.info("realtime output interrupted at \(interruptedAt, privacy: .public)s")
                }
                self.markOutputPlaybackFinished()
                self.startPendingOutputPlaybackIfNeeded()
            }
        }
    }

    private func finishOutputPlaybackStream() {
        guard let continuation = self.outputContinuation else {
            if self.outputTask != nil, !self.pendingOutputChunks.isEmpty {
                self.pendingOutputDone = true
            }
            return
        }
        continuation.finish()
        self.outputContinuation = nil
    }

    private func startPendingOutputPlaybackIfNeeded() {
        guard !self.pendingOutputChunks.isEmpty else {
            self.pendingOutputDone = false
            return
        }
        let chunks = self.pendingOutputChunks
        let shouldFinish = self.pendingOutputDone
        self.pendingOutputChunks = []
        self.pendingOutputDone = false
        self.ensureOutputPlaybackStarted()
        for chunk in chunks {
            self.markOutputAudioStarted(byteCount: chunk.count, nowMs: ProcessInfo.processInfo.systemUptime * 1000)
            self.onPhaseChanged(.speaking)
            self.outputContinuation?.yield(chunk)
        }
        if shouldFinish {
            self.finishOutputPlaybackStream()
        }
    }

    private func markOutputAudioStarted(byteCount: Int, nowMs: Double) {
        self.isOutputPlaying = true
        let bytesPerSecond = max(1, self.outputSampleRateHz * Double(MemoryLayout<Int16>.size))
        let chunkDurationMs = (Double(byteCount) / bytesPerSecond) * 1000
        self.outputPlaybackExpectedEndMs = max(nowMs, self.outputPlaybackExpectedEndMs) + chunkDurationMs
        self.scheduleOutputPlaybackIdle(expectedEndMs: self.outputPlaybackExpectedEndMs)
    }

    private func scheduleOutputPlaybackIdle(expectedEndMs: Double) {
        self.outputIdleTask?.cancel()
        let nowMs = ProcessInfo.processInfo.systemUptime * 1000
        let idleDelayMs = max(350, expectedEndMs - nowMs + 500)
        self.outputIdleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(idleDelayMs * 1_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self, !self.isClosed else { return }
                let nowMs = ProcessInfo.processInfo.systemUptime * 1000
                guard nowMs >= self.outputPlaybackExpectedEndMs + 500 else { return }
                self.markOutputPlaybackFinished(cancelIdleTask: false)
            }
        }
    }

    private func markOutputPlaybackFinished(cancelIdleTask: Bool = true) {
        if cancelIdleTask {
            self.outputIdleTask?.cancel()
            self.outputIdleTask = nil
        }
        self.isOutputPlaying = false
        self.outputPlaybackExpectedEndMs = 0
        self.onPhaseChanged(.listening)
    }

    private func stopOutputPlayback() {
        self.outputSessionId += 1
        self.outputContinuation?.finish()
        self.outputContinuation = nil
        self.outputTask?.cancel()
        self.outputTask = nil
        self.outputIdleTask?.cancel()
        self.outputIdleTask = nil
        self.pendingOutputChunks = []
        self.pendingOutputDone = false
        _ = self.pcmPlayer.stop()
        self.isOutputPlaying = false
        self.outputPlaybackExpectedEndMs = 0
    }

    private nonisolated static func encodePCM16(
        buffer: AVAudioPCMBuffer,
        inputSampleRate: Double,
        targetSampleRate: Double) -> Data
    {
        guard let channelData = buffer.floatChannelData,
              buffer.frameLength > 0,
              inputSampleRate > 0,
              targetSampleRate > 0
        else { return Data() }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        let outputCount = max(1, Int((Double(frameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
        var data = Data(capacity: outputCount * MemoryLayout<Int16>.size)
        for index in 0..<outputCount {
            let sourcePosition = Double(index) * inputSampleRate / targetSampleRate
            let lower = min(frameCount - 1, Int(sourcePosition.rounded(.down)))
            let upper = min(frameCount - 1, lower + 1)
            let fraction = Float(sourcePosition - Double(lower))
            var mixed: Float = 0
            for channel in 0..<channelCount {
                let samples = channelData[channel]
                mixed += samples[lower] + ((samples[upper] - samples[lower]) * fraction)
            }
            let sample = max(-1, min(1, mixed / Float(channelCount)))
            var intSample = Int16((sample * Float(Int16.max)).rounded()).littleEndian
            withUnsafeBytes(of: &intSample) { data.append(contentsOf: $0) }
        }
        return data
    }

    private nonisolated static func rmsLevel(buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        var sumSquares: Float = 0
        var samples = 0
        for channel in 0..<channelCount {
            let values = channelData[channel]
            for index in 0..<frameCount {
                let sample = values[index]
                sumSquares += sample * sample
                samples += 1
            }
        }
        guard samples > 0 else { return 0 }
        return sqrt(sumSquares / Float(samples))
    }

    private nonisolated static func safeLogMessage(_ value: String) -> String {
        let singleLine = value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        if singleLine.count <= 180 {
            return singleLine
        }
        return String(singleLine.prefix(180)) + "..."
    }
}
