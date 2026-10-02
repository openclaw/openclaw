#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import OpenClawProtocol
import OSLog

/// All mutable output state and legacy player access are serialized by `lock`.
/// Audio events and synchronous relay controls use the same critical section.
final class RealtimeTalkOutput: @unchecked Sendable {
    private let lock = NSLock()
    private let player: (any RealtimePCMPlayback)?
    private let legacyPlayer: PCMStreamingAudioPlaying
    private let transport: RealtimeTalkRelayTransport
    private let notification: AsyncStream<Void>.Continuation
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "RealtimeTalkRelay")
    private var effects: [Effect] = []
    private var pendingStartupEvents = 0
    var startupRoutingReady = false
    private var routingGeneration: UInt64 = 0
    var relaySessionId: String?
    var isClosed = false
    var outputSampleRateHz = 24000.0
    var outputTask: Task<Void, Never>?
    var outputContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    var pendingOutputAudio = Data()
    var outputSessionId = 0
    var pendingPlaybackMarks: [String] = []
    var isOutputPaused = false
    var reportedSpeaking = false
    var isOutputPlaying = false
    var outputIdentity: OutputIdentity?
    var suppressedOutputIdentity: OutputIdentity?
    var awaitingOutputClear = false
    var cancelledOutputTurnId: String?
    var terminalOutputCancellationReason: String?
    var cancellationInFlight = false
    var outputStartedAtMs: Double?
    var outputAudioChunkCount = 0
    var outputAudioByteCount = 0
    var envelope = OutputEnvelope()

    enum Effect: Sendable {
        case speaking(Bool), beginLevels, cancelLevels, stopLegacyPlayer, cancellationCleared
        case failure(String)
    }

    @MainActor
    init(
        player: PCMStreamingAudioPlaying,
        transport: RealtimeTalkRelayTransport,
        notification: AsyncStream<Void>.Continuation)
    {
        self.player = player as? any RealtimePCMPlayback
        self.legacyPlayer = player
        self.transport = transport
        self.notification = notification
    }

    deinit {
        self.outputContinuation?.finish()
        self.outputTask?.cancel()
        self.notification.finish()
    }

    func withLock<T>(_ body: (RealtimeTalkOutput) throws -> T) rethrows -> T {
        try self.lock.withLock { try body(self) }
    }

    private func emit(_ effect: Effect) {
        let notify = self.effects.isEmpty
        self.effects.append(effect)
        if notify {
            self.notification.yield(())
        }
    }

    func takeEffects() -> [Effect] {
        let effects = self.effects
        self.effects.removeAll(keepingCapacity: true)
        return effects
    }

    /// Do not let a newly routed frame overtake events buffered before relay creation. Once
    /// startup has drained, non-audio/UI events never put audio behind the main consumer.
    func resetRouting(lifecycleGeneration: UInt64) {
        self.routingGeneration = lifecycleGeneration
        self.pendingStartupEvents = 0
        self.startupRoutingReady = false
    }

    func route(_ event: EventFrame, lifecycleGeneration: UInt64) -> (handled: Bool, startup: Bool) {
        self.withLock { output in
            guard !output.isClosed, output.routingGeneration == lifecycleGeneration else { return (true, false) }
            if !output.startupRoutingReady || output.pendingStartupEvents > 0 {
                output.pendingStartupEvents += 1
                return (false, true)
            }
            return (output.handleAudioEvent(event), false)
        }
    }

    func mainEventHandled(startup: Bool, lifecycleGeneration: UInt64) {
        if startup, self.routingGeneration == lifecycleGeneration {
            self.pendingStartupEvents -= 1
        }
    }

    /// Caller holds the output lock (route or the main startup consumer).
    func handleAudioEvent(_ event: EventFrame) -> Bool {
        guard !self.isClosed, let relaySessionId = self.relaySessionId,
              event.event == "talk.event", let payload = event.payload?.dictionaryValue,
              payload["relaySessionId"]?.stringValue == relaySessionId else { return false }
        switch payload["type"]?.stringValue {
        case "audio": self.handleOutputAudio(payload)
        case "audioDone": self.handleOutputAudioDone(payload)
        case "clear": self.handleOutputClear(payload)
        case "mark": self.handlePlaybackMark(payload)
        default: return false
        }
        return true
    }

    struct OutputIdentity: Equatable, Sendable {
        let turnId: String?

        init(_ payload: [String: AnyCodable]) {
            self.turnId = payload["talkEvent"]?.dictionaryValue?["turnId"]?.stringValue?.trimmedNonEmpty
        }
    }

    func retireCancellation() {
        self.suppressedOutputIdentity = nil
        self.awaitingOutputClear = false
        self.cancellationInFlight = false
    }

    func handleOutputClear(_ payload: [String: AnyCodable]) {
        let clearIdentity = OutputIdentity(payload)
        // Provider clears retire playback; only turn.cancelled acknowledges turn cancellation.
        let clearsSuppressed = self.awaitingOutputClear &&
            payload["talkEvent"]?.dictionaryValue?["type"]?.stringValue == "turn.cancelled" &&
            self.suppressedOutputIdentity == clearIdentity
        if clearsSuppressed {
            self.awaitingOutputClear = false
            if !self.cancellationInFlight {
                self.suppressedOutputIdentity = nil
                self.emit(.cancellationCleared)
            }
        }
        let currentMatches = clearIdentity.turnId == nil || self.outputIdentity == clearIdentity
        guard clearsSuppressed || currentMatches else { return }
        let marks = self.takePendingPlaybackMarks()
        // Cancellation already published the stopped state. A later clear with no
        // active output only retires the fence; it must not emit a duplicate callback.
        if self.isOutputPlaying || self.outputIdentity != nil {
            self.stopOutputPlayback()
        }
        self.acknowledgePlaybackMarks(marks)
    }

    func recordOutputAudioChunk(byteCount: Int) {
        self.outputAudioChunkCount += 1
        self.outputAudioByteCount += byteCount
        guard self.outputAudioChunkCount == 1 || self.outputAudioChunkCount % 20 == 0 else { return }
        let chunks = self.outputAudioChunkCount
        let bytes = self.outputAudioByteCount
        self.logger.debug("talk realtime audio: chunks=\(chunks) bytes=\(bytes)")
    }

    func markOutputAudioStarted(nowMs: Double) {
        if !self.isOutputPlaying {
            self.outputStartedAtMs = nowMs
        }
        self.isOutputPlaying = true
    }

    func finishOutputPlaybackStream() {
        guard let continuation = outputContinuation else { return }
        if !self.pendingOutputAudio.isEmpty {
            let trailingFrame = self.pendingOutputAudio
            self.pendingOutputAudio.removeAll(keepingCapacity: true)
            guard self.yieldOutputAudioFrame(trailingFrame) else { return }
        }
        continuation.finish()
        self.outputContinuation = nil
    }

    func markOutputPlaybackFinished() {
        // Only drained playback completes output; elapsed time cannot prove the
        // device finished queued audio. Publish the terminal transition once.
        guard self.isOutputPlaying else { return }
        self.isOutputPlaying = false
        self.outputIdentity = nil
        self.outputStartedAtMs = nil
        self.envelope.cancel()
        self.emit(.cancelLevels)
        self.reportSpeaking(false)
        self.acknowledgePlaybackMarks(self.takePendingPlaybackMarks())
    }

    func takePendingPlaybackMarks() -> [String] {
        let marks = self.pendingPlaybackMarks
        self.pendingPlaybackMarks.removeAll()
        return marks
    }

    func handlePlaybackMark(_ payload: [String: AnyCodable]) {
        guard let markName = payload["markName"]?.stringValue?.trimmedNonEmpty else { return }
        if self.isOutputPlaying {
            self.pendingPlaybackMarks.append(markName)
        } else {
            self.acknowledgePlaybackMarks([markName])
        }
    }

    func acknowledgePlaybackMarks(_ marks: [String]) {
        guard !marks.isEmpty,
              let relaySessionId
        else { return }
        for markName in marks {
            Task { [transport, logger] in
                let payload: [String: AnyCodable] = [
                    "sessionId": AnyCodable(relaySessionId),
                    "markName": AnyCodable(markName),
                ]
                do {
                    _ = try await transport.request("talk.session.acknowledgeMark", payload, 8000)
                } catch {
                    let message = String(error.localizedDescription.prefix(180))
                    logger.warning(
                        "talk realtime: mark acknowledgement failed=\(message, privacy: .public)")
                }
            }
        }
    }

    func stopOutputPlayback() {
        self.outputSessionId += 1
        self.outputContinuation?.finish()
        self.outputContinuation = nil
        self.pendingOutputAudio.removeAll(keepingCapacity: true)
        self.outputTask?.cancel()
        self.outputTask = nil
        if let player {
            _ = player.stop()
        } else {
            self.emit(.stopLegacyPlayer)
        }
        self.isOutputPlaying = false
        self.outputIdentity = nil
        self.outputStartedAtMs = nil
        self.envelope.cancel()
        self.emit(.cancelLevels)
        self.reportSpeaking(false)
    }

    func handleOutputAudio(_ payload: [String: AnyCodable]) {
        guard !self.isOutputPaused else { return }
        let incomingIdentity = OutputIdentity(payload)
        guard let incomingTurnId = incomingIdentity.turnId else {
            self.handleOutputPlaybackOverflow()
            return
        }
        guard !self.awaitingOutputClear else { return }
        guard incomingTurnId != self.cancelledOutputTurnId else { return }
        guard let base64 = payload["audioBase64"]?.stringValue else { return }
        guard let data = Data(base64Encoded: base64) else {
            self.handleOutputPlaybackOverflow()
            return
        }
        self.terminalOutputCancellationReason = nil
        if let currentIdentity = outputIdentity,
           currentIdentity != incomingIdentity
        {
            let marks = self.takePendingPlaybackMarks()
            self.stopOutputPlayback()
            self.acknowledgePlaybackMarks(marks)
        } else if self.outputContinuation == nil, self.outputTask != nil {
            self.stopOutputPlayback()
        }
        self.outputIdentity = incomingIdentity
        self.recordOutputAudioChunk(byteCount: data.count)
        self.markOutputAudioStarted(nowMs: ProcessInfo.processInfo.systemUptime * 1000)
        self.reportSpeaking(true)
        self.ensureOutputPlaybackStarted()
        self.bufferOutputAudio(data)
    }

    func reportSpeaking(_ speaking: Bool) {
        // Only the per-chunk `true` floods; `false` comes from idempotent teardown paths.
        guard !(speaking && self.reportedSpeaking) else { return }
        self.reportedSpeaking = speaking
        self.emit(.speaking(speaking))
    }

    func bufferOutputAudio(_ data: Data) {
        let frameByteCount = max(2, Int((outputSampleRateHz * 0.02).rounded()) * 2)
        var offset = data.startIndex
        if !self.pendingOutputAudio.isEmpty {
            let fillCount = min(frameByteCount - self.pendingOutputAudio.count, data.count)
            let fillEnd = data.index(offset, offsetBy: fillCount)
            self.pendingOutputAudio.append(data[offset..<fillEnd])
            offset = fillEnd
            if self.pendingOutputAudio.count == frameByteCount {
                let frame = self.pendingOutputAudio
                self.pendingOutputAudio.removeAll(keepingCapacity: true)
                guard self.yieldOutputAudioFrame(frame) else { return }
            }
        }
        while data.distance(from: offset, to: data.endIndex) >= frameByteCount {
            let frameEnd = data.index(offset, offsetBy: frameByteCount)
            let frame = Data(data[offset..<frameEnd])
            offset = frameEnd
            guard self.yieldOutputAudioFrame(frame) else { return }
        }
        if offset < data.endIndex {
            self.pendingOutputAudio.append(data[offset...])
        }
    }

    func yieldOutputAudioFrame(_ data: Data) -> Bool {
        guard let continuation = outputContinuation else { return false }
        switch continuation.yield(data) {
        case .enqueued:
            if self.envelope.append(data) { self.emit(.beginLevels) }
            return true
        case .dropped:
            self.handleOutputPlaybackOverflow()
            return false
        case .terminated:
            return false
        @unknown default:
            self.handleOutputPlaybackOverflow()
            return false
        }
    }

    func handleOutputAudioDone(_ payload: [String: AnyCodable]) {
        let incomingIdentity = OutputIdentity(payload)
        if incomingIdentity.turnId != nil,
           let outputIdentity,
           outputIdentity != incomingIdentity
        {
            return
        }
        self.finishOutputPlaybackStream()
    }

    private func ensureOutputPlaybackStarted() {
        guard self.outputContinuation == nil, self.outputTask == nil else { return }
        self.outputSessionId += 1
        let sessionId = self.outputSessionId
        let sampleRate = self.outputSampleRateHz
        self.envelope.begin(sampleRate: sampleRate)
        self.emit(.beginLevels)
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(
            bufferingPolicy: .bufferingOldest(RealtimeTalkRelaySession.maxBufferedOutputChunks))
        self.outputContinuation = continuation
        // The real backend registers its generation under the output lock, so a stop
        // cannot race a delayed task that starts an already-retired reply. Actor-bound legacy
        // players remain supported for existing clients/fakes, but are not the realtime backend.
        let playback: Task<StreamingPlaybackResult, Never> = if let player {
            player.beginPlayback(stream: stream, sampleRate: sampleRate)
        } else {
            Task { @MainActor [legacyPlayer] in
                guard !Task.isCancelled else {
                    return StreamingPlaybackResult(finished: false, interruptedAt: nil)
                }
                return await legacyPlayer.play(stream: stream, sampleRate: sampleRate)
            }
        }
        self.outputTask = Task.detached(priority: .high) { [weak self] in
            let result = await withTaskCancellationHandler {
                await playback.value
            } onCancel: { playback.cancel() }
            self?.withLock { output in
                guard output.outputSessionId == sessionId, !output.isClosed else { return }
                output.outputTask = nil
                output.outputContinuation = nil
                if result.finished {
                    output.markOutputPlaybackFinished()
                } else {
                    output.handleOutputPlaybackFailure(
                        String(localized: "Realtime audio playback failed. Reconnecting…"))
                }
            }
        }
    }

    private func handleOutputPlaybackOverflow() {
        self.handleOutputPlaybackFailure(
            String(localized: "Realtime audio playback fell behind. Reconnecting…"))
    }

    private func handleOutputPlaybackFailure(_ message: String) {
        guard !self.isClosed else { return }
        // Fence immediately; main may be busy, but no more audio can enter after failure.
        self.isClosed = true
        self.stopOutputPlayback()
        self.emit(.failure(message))
    }

    /// Same PCM-time envelope as PCMPlaybackEnvelope, sampled by the UI at 30 Hz. Metering
    /// and its timeline are output-lock-owned; publishing levels never gates scheduling.
    struct OutputEnvelope {
        private struct Segment { let start: Double
            let end: Double
            let level: Double
        }

        private var segments: [Segment] = []
        private var bytesPerSecond = 0.0
        private var startedAt: Double?
        private var scheduleEnd = 0.0

        mutating func begin(sampleRate: Double) {
            self.cancel()
            self.bytesPerSecond = max(1, sampleRate * 2)
        }

        mutating func append(_ data: Data) -> Bool {
            guard self.bytesPerSecond > 1, !data.isEmpty else { return false }
            let restarting = self.startedAt == nil
            let now = ProcessInfo.processInfo.systemUptime
            if self.startedAt == nil {
                self.startedAt = now
            }
            var start = max(now - (startedAt ?? now), self.scheduleEnd)
            let windowBytes = max(2, Int(bytesPerSecond * 0.05) & ~1)
            var offset = data.startIndex
            while offset < data.endIndex {
                let end = min(offset + windowBytes, data.endIndex)
                let window = Data(data[offset..<end])
                let duration = Double(window.count) / self.bytesPerSecond
                self.segments.append(Segment(
                    start: start,
                    end: start + duration,
                    level: TalkAudioLevel.normalized(rms: TalkAudioLevel.pcm16RMS(window))))
                start += duration
                offset = end
            }
            self.scheduleEnd = start
            return restarting
        }

        mutating func level() -> Double? {
            guard let startedAt else { return 0 }
            let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
            guard elapsed <= self.scheduleEnd + 0.5 else {
                self.cancel()
                return nil
            }
            self.segments.removeAll { $0.end < elapsed }
            return self.segments.first { elapsed >= $0.start && elapsed < $0.end }?.level ?? 0
        }

        mutating func cancel() {
            self.segments.removeAll(keepingCapacity: true)
            self.startedAt = nil
            self.scheduleEnd = 0
        }
    }
}
#endif
