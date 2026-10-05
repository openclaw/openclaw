#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import AVFAudio
import Foundation
import OpenClawProtocol
import OSLog

public enum RealtimeTalkRecovery {
    private static let stableSessionSeconds: TimeInterval = 30
    private static let restartDelaysNanoseconds: [UInt64] = [500_000_000, 2_000_000_000]

    public static func restartAttempt(previousRapidRestarts: Int, activeDuration: TimeInterval) -> Int {
        activeDuration >= self.stableSessionSeconds ? 1 : previousRapidRestarts + 1
    }

    public static func restartDelayNanoseconds(attempt: Int) -> UInt64? {
        guard attempt > 0, attempt <= self.restartDelaysNanoseconds.count else { return nil }
        return self.restartDelaysNanoseconds[attempt - 1]
    }
}

public struct RealtimeTalkAudioFrame: Sendable {
    public let data: Data
    public let timestampMs: Double
    public let rms: Float

    public init(data: Data, timestampMs: Double, rms: Float) {
        self.data = data
        self.timestampMs = timestampMs
        self.rms = rms
    }
}

public enum RealtimeTalkPCM16Encoder {
    public nonisolated static func encode(
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
}

@MainActor
public protocol RealtimeTalkAudioCapturing: AnyObject {
    var suppressesInputDuringOutput: Bool { get }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws

    func stop()
}

public struct RealtimeTalkRelayTransport: Sendable {
    public let subscribeServerEvents: @Sendable (Int) async -> AsyncStream<EventFrame>
    public let request: @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data
    public let isCurrent: @Sendable () async -> Bool

    public init(
        subscribeServerEvents: @escaping @Sendable (Int) async -> AsyncStream<EventFrame>,
        request: @escaping @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data,
        isCurrent: @escaping @Sendable () async -> Bool = { true })
    {
        self.subscribeServerEvents = subscribeServerEvents
        self.request = request
        self.isCurrent = isCurrent
    }
}

public struct RealtimeTalkRelayIssue: Equatable, Sendable {
    public let code: String
    public let message: String
    public let provider: String?
    public let model: String?
    public let transport: String?
    public let phase: String?

    public init(
        code: String = "realtime_unavailable",
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil)
    {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.provider = provider
        self.model = model
        self.transport = transport
        self.phase = phase
    }
}

public struct RealtimeTalkTranscript: Equatable, Sendable {
    public let role: String
    public let text: String
    public let isFinal: Bool

    public init(role: String, text: String, isFinal: Bool) {
        self.role = role
        self.text = text
        self.isFinal = isFinal
    }
}

public enum RealtimeTalkRelayTermination: Equatable, Sendable {
    case remoteClose(reason: String?)
    case outputCancelled(reason: String)
    case eventStreamEnded
    case audioInputFailed(message: String)
    case outputCancellationFailed
    case outputPlaybackOverflow
}

private enum RealtimeAudioSendOutcome {
    case sent, inactive, saturated, failed(String)
}

private actor RealtimeAudioSender {
    private let request: @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data
    private var relaySessionId: String?
    private var pendingSends = 0

    init(
        relaySessionId: String,
        request: @escaping @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data)
    {
        self.relaySessionId = relaySessionId
        self.request = request
    }

    func close() {
        self.relaySessionId = nil
    }

    func send(_ data: Data, timestampMs: Double) async -> RealtimeAudioSendOutcome {
        guard !Task.isCancelled, let relaySessionId else { return .inactive }
        guard self.pendingSends < RealtimeTalkRelaySession.maxPendingAudioSends else { return .saturated }
        self.pendingSends += 1
        defer { self.pendingSends -= 1 }
        // The Gateway carries this straight into the provider's media timeline, and OpenAI rejects
        // a `conversation.item.truncate` whose `audio_end_ms` is not an integer -- a fractional
        // timestamp here kills the session on the first barge-in.
        let payload: [String: AnyCodable] = [
            "sessionId": AnyCodable(relaySessionId),
            "audioBase64": AnyCodable(data.base64EncodedString()),
            "timestamp": AnyCodable(timestampMs.rounded()),
        ]
        do {
            try Task.checkCancellation()
            let response = try await self.request("talk.session.appendAudio", payload, 8000)
            try Task.checkCancellation()
            _ = try JSONDecoder().decode(TalkSessionOkResult.self, from: response)
            return .sent
        } catch {
            return Task.isCancelled ? .inactive : .failed(error.localizedDescription)
        }
    }
}

@MainActor
public final class RealtimeTalkRelaySession {
    private static let agentControlToolName = "openclaw_agent_control"

    public struct Options: Sendable {
        public let sessionKey: String
        public let provider: String?
        public let model: String?
        public let voice: String?
        public let supportsVoiceSelection: Bool
        public let voiceChangeId: String?

        public init(
            sessionKey: String,
            provider: String?,
            model: String?,
            voice: String?,
            supportsVoiceSelection: Bool = false,
            voiceChangeId: String? = nil)
        {
            self.sessionKey = sessionKey
            self.provider = provider
            self.model = model
            self.voice = voice
            self.supportsVoiceSelection = supportsVoiceSelection
            self.voiceChangeId = voiceChangeId
        }
    }

    private struct ToolCallStartResponse: Decodable {
        let runId: String?
        let idempotencyKey: String?
    }

    private struct ChatCompletionResult {
        let text: String?
        let failed: Bool
    }

    private struct RelayChatEvent: Decodable {
        let runId: String?
        let state: String?
        let message: AnyCodable?
    }

    private enum StartupWaitResult {
        case ready
        case failed(RealtimeTalkRelayIssue)
        case cancelled
    }

    /// Startup abandons for two very different reasons and callers must not treat them alike.
    /// Local cancellation is caller-initiated and stays silent; a lost Gateway route is an
    /// external failure the runtime has to see, or Talk reports listening with no relay behind it.
    private enum LifecycleStatus {
        case current
        case cancelledLocally
        case routeLost
    }

    private nonisolated static let expectedInputEncoding = "pcm16"
    private nonisolated static let expectedOutputEncoding = "pcm16"
    private nonisolated static let defaultSampleRateHz = 24000
    private nonisolated static let bargeInRmsThreshold: Float = 0.08
    private nonisolated static let bargeInCooldownMs: Double = 900
    private nonisolated static let minOutputBeforeBargeInMs: Double = 250
    private nonisolated static let startupReadyTimeoutSeconds = 12
    /// Providers may deliver a whole reply faster than realtime (xAI sends it in one burst), so the
    /// bound must hold a full reply: 60 s of 20 ms frames (~2.9 MB at 24 kHz). Overflow still
    /// terminates the session so recovery replaces a stalled playback path.
    /// In-flight `talk.session.appendAudio` requests before input counts as stalled. Each mic
    /// callback (~43 ms) is one request; Gateway round trips over Wi-Fi/Tailscale spike to ~1 s, so
    /// 48 tolerates ~2 s of latency instead of the ~170 ms that 4 allowed.
    nonisolated static let maxPendingAudioSends = 48
    nonisolated static let maxBufferedOutputChunks = 3000

    private let transport: RealtimeTalkRelayTransport
    private let audioCapture: any RealtimeTalkAudioCapturing
    private let options: Options
    private let pcmPlayer: PCMStreamingAudioPlaying
    private let output: RealtimeTalkOutput
    private var outputEffectsTask: Task<Void, Never>?
    private var outputLevelTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "RealtimeTalkRelay")
    private let onStatus: (String) -> Void
    private let onIssue: (RealtimeTalkRelayIssue) -> Void
    private let onTermination: (RealtimeTalkRelayTermination) -> Void
    private let onSpeakingChanged: (Bool) -> Void
    private let onInputLevel: (Double) -> Void
    private let onOutputLevel: (Double?) -> Void
    private let onTranscript: (RealtimeTalkTranscript) -> Void

    private var relaySessionId: String?
    private var serverClose: (sessionId: String, task: Task<Void, Error>)?
    private var hasReceivedReady = false
    private var hasReceivedFailure = false
    private var startupIssue: RealtimeTalkRelayIssue?
    private var startupWaiter: CheckedContinuation<StartupWaitResult, Never>?
    private var pendingPreRelayEvents: [EventFrame] = []
    private var inputSampleRateHz = Double(RealtimeTalkRelaySession.defaultSampleRateHz)
    private var supportsBargeIn: Bool? = true
    private var eventTask: Task<Void, Never>?
    private var toolCallTasks: [UUID: Task<Void, Never>] = [:]
    private var audioSendTasks: [UUID: Task<Void, Never>] = [:]
    private var audioSender: RealtimeAudioSender?
    private var isInputPaused = false
    private var audioCaptureGeneration: UInt64 = 0
    private var isClosed = false
    private var lifecycleGeneration: UInt64 = 0
    private var outputCancellationGeneration: UInt64 = 0
    private var outputCancellationTask: Task<Void, Never>?
    private var lastBargeInAtMs: Double = 0
    private var micLogFrameCount = 0
    private var micLogByteCount = 0
    private var micLogMaxRms: Float = 0
    private var lastMicLogAtMs: Double = 0
    private var suppressedEchoFrameCount = 0
    private var suppressedEchoByteCount = 0
    private var suppressedEchoMaxRms: Float = 0
    private var lastSuppressedEchoLogAtMs: Double = 0

    public var voiceSessionId: String? {
        self.relaySessionId
    }

    public var isReady: Bool {
        !self.isClosed && self.hasReceivedReady && !self.hasReceivedFailure && self.relaySessionId != nil
    }

    public init(
        transport: RealtimeTalkRelayTransport,
        options: Options,
        audioCapture: any RealtimeTalkAudioCapturing,
        pcmPlayer: PCMStreamingAudioPlaying,
        onStatus: @escaping (String) -> Void,
        onIssue: @escaping (RealtimeTalkRelayIssue) -> Void = { _ in },
        onTermination: @escaping (RealtimeTalkRelayTermination) -> Void = { _ in },
        onSpeakingChanged: @escaping (Bool) -> Void,
        onInputLevel: @escaping (Double) -> Void = { _ in },
        onOutputLevel: @escaping (Double?) -> Void = { _ in },
        onTranscript: @escaping (RealtimeTalkTranscript) -> Void = { _ in })
    {
        self.transport = transport
        self.audioCapture = audioCapture
        self.options = options
        self.pcmPlayer = pcmPlayer
        let notifications = AsyncStream<Void>.makeStream()
        self.output = RealtimeTalkOutput(
            player: pcmPlayer,
            transport: transport,
            notification: notifications.continuation)
        self.onStatus = onStatus
        self.onIssue = onIssue
        self.onTermination = onTermination
        self.onSpeakingChanged = onSpeakingChanged
        self.onInputLevel = onInputLevel
        self.onOutputLevel = onOutputLevel
        self.onTranscript = onTranscript
        self.outputEffectsTask = Task { @MainActor [weak self] in
            for await _ in notifications.stream {
                guard let self else { return }
                self.drainOutputEffects()
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
        self.outputEffectsTask?.cancel()
        self.outputLevelTask?.cancel()
    }

    public func start() async throws {
        self.lifecycleGeneration &+= 1
        let lifecycleGeneration = self.lifecycleGeneration
        self.isClosed = false
        self.output.withLock {
            $0.isClosed = false
            $0.relaySessionId = nil
            $0.resetRouting(lifecycleGeneration: lifecycleGeneration)
        }
        self.hasReceivedReady = false
        self.hasReceivedFailure = false
        self.supportsBargeIn = nil
        self.startupIssue = nil
        self.startupWaiter = nil
        self.pendingPreRelayEvents.removeAll()
        self.onStatus("Connecting realtime…")
        let eventStream = await transport.subscribeServerEvents(200)
        switch await lifecycleStatus(lifecycleGeneration) {
        case .current: break
        case .cancelledLocally: return
        case .routeLost: throw Self.gatewayRouteLostError()
        }
        self.startEventPump(stream: eventStream, lifecycleGeneration: lifecycleGeneration)
        do {
            let result = try await createRelaySession()
            let createdRelaySessionId = result.relaysessionid?.trimmedNonEmpty
            let statusAfterCreate = await lifecycleStatus(lifecycleGeneration)
            if statusAfterCreate != .current {
                if let relaySessionId = createdRelaySessionId {
                    try? await self.beginServerClose(relaySessionId: relaySessionId).value
                }
                if statusAfterCreate == .routeLost {
                    throw Self.gatewayRouteLostError()
                }
                return
            }
            if let startupIssue {
                if let relaySessionId = createdRelaySessionId {
                    try? await self.beginServerClose(relaySessionId: relaySessionId).value
                }
                throw Self.startupFailureError(startupIssue)
            }
            guard let relaySessionId = createdRelaySessionId else {
                throw NSError(domain: "RealtimeTalkRelay", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: String(
                        localized: "Gateway did not return a realtime relay session"),
                ])
            }
            self.relaySessionId = relaySessionId
            // Acknowledgments need identity during startup; routing stays gated until replay finishes.
            self.output.withLock { $0.relaySessionId = relaySessionId }
            let supportsBargeIn = await resolveSupportsBargeIn(result)
            switch await lifecycleStatus(lifecycleGeneration) {
            case .current: break
            case .cancelledLocally: return
            case .routeLost: throw Self.gatewayRouteLostError()
            }
            self.supportsBargeIn = supportsBargeIn
            self.audioSender = RealtimeAudioSender(
                relaySessionId: relaySessionId,
                request: self.transport.request)
            self.configureAudioContract(result.audio)
            try startMicrophonePump(lifecycleGeneration: lifecycleGeneration)
            self.onStatus("Waiting for realtime…")
            await drainPendingPreRelayEvents(lifecycleGeneration: lifecycleGeneration)
            self.output.withLock { $0.startupRoutingReady = true }
            switch await lifecycleStatus(lifecycleGeneration) {
            case .current: break
            case .cancelledLocally: return
            case .routeLost: throw Self.gatewayRouteLostError()
            }
            switch await waitForStartupResult(
                timeoutSeconds: Self.startupReadyTimeoutSeconds,
                lifecycleGeneration: lifecycleGeneration)
            {
            case .ready, .cancelled:
                return
            case let .failed(issue):
                throw Self.startupFailureError(issue)
            }
        } catch {
            // A lost route must still surface: swallowing here would discard both the original
            // failure and the route loss, leaving the runtime with nothing to fall back from.
            if await lifecycleStatus(lifecycleGeneration) == .cancelledLocally {
                return
            }
            let createdRelaySessionId = self.relaySessionId
            self.close(sendClose: false)
            if let createdRelaySessionId {
                try? await self.beginServerClose(relaySessionId: createdRelaySessionId).value
            }
            throw error
        }
    }

    public func stop() {
        self.close(sendClose: true)
    }

    /// The close event precedes transcript persistence; replacements must wait for the RPC response.
    public func stopAndWait() async throws {
        self.stop()
        try await self.serverClose?.task.value
    }

    private func close(sendClose: Bool) {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.outputCancellationGeneration &+= 1
        self.outputCancellationTask?.cancel()
        self.outputCancellationTask = nil
        self.output.withLock { output in
            let wasClosed = output.isClosed
            output.isClosed = true
            output.relaySessionId = nil
            output.pendingPlaybackMarks.removeAll()
            output.cancelledOutputTurnId = nil
            output.terminalOutputCancellationReason = nil
            output.isOutputPaused = false
            output.retireCancellation()
            if !wasClosed { output.stopOutputPlayback() }
            output.reportSpeaking(false)
        }
        self.lifecycleGeneration &+= 1
        finishStartupWait(.cancelled)
        stopMicrophonePump()
        self.eventTask?.cancel()
        self.eventTask = nil
        for task in self.toolCallTasks.values {
            task.cancel()
        }
        let audioSender = self.audioSender
        self.audioSender = nil
        Task { await audioSender?.close() }
        self.drainOutputEffects()
        if sendClose, let relaySessionId {
            self.beginServerClose(relaySessionId: relaySessionId)
        }
        relaySessionId = nil
    }

    /// Deliberately not a `CancellationError`: the runtime treats those as caller-initiated and
    /// returns silently, while any other error routes Talk to its native fallback.
    private nonisolated static func gatewayRouteLostError() -> NSError {
        NSError(domain: "RealtimeTalkRelay", code: 7, userInfo: [
            NSLocalizedDescriptionKey: String(
                localized: "Gateway connection was replaced before realtime startup finished"),
        ])
    }

    private nonisolated static func startupFailureError(_ issue: RealtimeTalkRelayIssue) -> NSError {
        NSError(domain: "RealtimeTalkRelay", code: 6, userInfo: [
            NSLocalizedDescriptionKey: issue.message,
        ])
    }

    @discardableResult
    private func beginServerClose(relaySessionId: String) -> Task<Void, Error> {
        if let serverClose, serverClose.sessionId == relaySessionId {
            return serverClose.task
        }
        let task = Task { [transport] in
            let payload = ["sessionId": AnyCodable(relaySessionId)]
            let response = try await transport.request("talk.session.close", payload, 8000)
            let result = try JSONDecoder().decode(TalkSessionOkResult.self, from: response)
            guard result.ok else { throw URLError(.badServerResponse) }
        }
        self.serverClose = (relaySessionId, task)
        return task
    }

    public func setInputPaused(_ paused: Bool) throws {
        guard self.isInputPaused != paused else { return }
        self.isInputPaused = paused
        if paused {
            self.stopMicrophonePump()
            self.onInputLevel(0)
        } else if !self.isClosed, self.relaySessionId != nil {
            do {
                try self.startMicrophonePump(lifecycleGeneration: self.lifecycleGeneration)
            } catch {
                self.isInputPaused = true
                throw error
            }
        }
    }

    public func setOutputPaused(_ paused: Bool) {
        let cancel = self.output.withLock { output in
            guard output.isOutputPaused != paused else { return false }
            output.isOutputPaused = paused
            return paused && output.isOutputPlaying
        }
        if cancel {
            cancelOutput(reason: "pause")
        }
    }

    private func createRelaySession() async throws -> TalkSessionCreateResult {
        var payload: [String: AnyCodable] = [
            "sessionKey": AnyCodable(self.options.sessionKey),
            "mode": AnyCodable("realtime"),
            "transport": AnyCodable("gateway-relay"),
            "brain": AnyCodable("agent-consult"),
        ]
        if let provider = self.options.provider?.trimmedNonEmpty {
            payload["provider"] = AnyCodable(provider)
        }
        if let model = self.options.model?.trimmedNonEmpty {
            payload["model"] = AnyCodable(model)
        }
        if let voice = self.options.voice?.trimmedNonEmpty {
            payload["voice"] = AnyCodable(voice)
        }
        if self.options.supportsVoiceSelection {
            payload["capabilities"] = AnyCodable(["voice-selection"])
        }
        if let voiceChangeId = self.options.voiceChangeId?.trimmedNonEmpty {
            payload["voiceChangeId"] = AnyCodable(voiceChangeId)
        }
        let response = try await self.transport.request("talk.session.create", payload, 20000)
        return try JSONDecoder().decode(TalkSessionCreateResult.self, from: response)
    }

    private func configureAudioContract(_ raw: AnyCodable?) {
        guard let audio = raw?.dictionaryValue else { return }
        let inputEncoding = audio["inputEncoding"]?.stringValue ?? Self.expectedInputEncoding
        let outputEncoding = audio["outputEncoding"]?.stringValue ?? Self.expectedOutputEncoding
        if inputEncoding != Self.expectedInputEncoding || outputEncoding != Self.expectedOutputEncoding {
            let message = "unexpected realtime relay audio contract input=\(inputEncoding) output=\(outputEncoding)"
            self.logger.warning("\(message, privacy: .public)")
        }
        self.inputSampleRateHz = audio["inputSampleRateHz"]?.doubleValue
            ?? Double(Self.defaultSampleRateHz)
        self.output.withLock {
            $0.outputSampleRateHz = audio["outputSampleRateHz"]?.doubleValue ?? Double(Self.defaultSampleRateHz)
        }
    }

    private func resolveSupportsBargeIn(_ session: TalkSessionCreateResult) async -> Bool? {
        var payload: [String: AnyCodable] = [:]
        if let provider = (session.provider ?? self.options.provider)?.trimmedNonEmpty {
            payload["provider"] = AnyCodable(provider)
        }
        if let model = (session.model ?? self.options.model)?.trimmedNonEmpty {
            payload["model"] = AnyCodable(model)
        }
        // A talk-only client may create sessions without permission to read the catalog.
        // Unknown capability leaves interruption ownership with the provider.
        guard let response = try? await self.transport.request("talk.catalog", payload, 8000),
              let catalog = try? JSONDecoder().decode(TalkCatalogResult.self, from: response)
        else { return nil }
        let provider = (payload["provider"]?.stringValue
            ?? catalog.realtime["activeProvider"]?.stringValue)?.lowercased()
        let entry = catalog.realtime["providers"]?.arrayValue?.first {
            guard let entry = $0.dictionaryValue, let provider else { return false }
            return entry["id"]?.stringValue?.lowercased() == provider ||
                entry["aliases"]?.arrayValue?.contains { $0.stringValue?.lowercased() == provider } == true
        }?.dictionaryValue
        return entry?["supportsBargeIn"]?.boolValue ?? true
    }

    private func drainOutputEffects() {
        for effect in self.output.withLock({ $0.takeEffects() }) {
            switch effect {
            case let .speaking(speaking): self.onSpeakingChanged(speaking)
            case .stopLegacyPlayer: _ = self.pcmPlayer.stop()
            case .beginLevels:
                self.outputLevelTask?.cancel()
                self.outputLevelTask = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        guard let self else { return }
                        let level = self.output.withLock { $0.envelope.level() }
                        guard let level else {
                            self.onOutputLevel(nil)
                            return
                        }
                        self.onOutputLevel(level)
                        try? await Task.sleep(for: .milliseconds(33))
                    }
                }
            case .cancelLevels:
                self.outputLevelTask?.cancel()
                self.outputLevelTask = nil
                self.onOutputLevel(nil)
            case .cancellationCleared:
                if self.outputCancellationTask == nil, !self.output.withLock({ $0.awaitingOutputClear }) {
                    self.retireOutputCancellation()
                }
            case let .failure(message): handleOutputPlaybackFailure(message)
            }
        }
    }

    private func startEventPump(stream: AsyncStream<EventFrame>, lifecycleGeneration: UInt64) {
        self.eventTask?.cancel()
        let mainEvents = AsyncStream<(event: EventFrame, startup: Bool)>.makeStream()
        let consumer = Task { @MainActor [weak self] in
            for await delivery in mainEvents.stream {
                guard !Task.isCancelled else { return }
                await self?.handleGatewayEvent(delivery.event, lifecycleGeneration: lifecycleGeneration)
                self?.output.withLock {
                    $0.mainEventHandled(startup: delivery.startup, lifecycleGeneration: lifecycleGeneration)
                }
            }
            guard !Task.isCancelled else { return }
            await self?.handleEventStreamEnded(lifecycleGeneration: lifecycleGeneration)
        }
        self.eventTask = Task.detached(priority: .high) { [output = self.output] in
            await withTaskCancellationHandler {
                for await event in stream {
                    guard !Task.isCancelled else { break }
                    let route = output.route(event, lifecycleGeneration: lifecycleGeneration)
                    if !route.handled {
                        mainEvents.continuation.yield((event, route.startup))
                    }
                }
                mainEvents.continuation.finish()
                await consumer.value
            } onCancel: {
                mainEvents.continuation.finish()
                consumer.cancel()
            }
        }
    }
}

extension RealtimeTalkRelaySession {
    private func handleEventStreamEnded(lifecycleGeneration: UInt64) async {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
        self.logger.debug("talk realtime: event stream ended")
        guard self.hasReceivedReady else {
            guard !self.hasReceivedFailure else { return }
            let issue = self.issue(
                message: String(localized: "Realtime connection ended before it became ready."),
                phase: "connect")
            self.hasReceivedFailure = true
            self.startupIssue = issue
            self.onIssue(issue)
            self.onStatus(issue.message)
            self.finishStartupWait(.failed(issue))
            return
        }
        self.onStatus("Ready")
        self.close(sendClose: false)
        self.onTermination(.eventStreamEnded)
    }

    private func handleGatewayEvent(_ event: EventFrame, lifecycleGeneration: UInt64) async {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
        guard event.event == "talk.event",
              let payload = event.payload?.dictionaryValue
        else { return }
        guard let relaySessionId else {
            self.pendingPreRelayEvents.append(event)
            if self.pendingPreRelayEvents.count > 200 {
                self.pendingPreRelayEvents.removeFirst(self.pendingPreRelayEvents.count - 200)
            }
            return
        }
        if payload["relaySessionId"]?.stringValue != relaySessionId {
            return
        }
        guard let type = payload["type"]?.stringValue else { return }
        switch type {
        case "ready":
            self.hasReceivedReady = true
            self.finishStartupWait(.ready)
            self.onStatus("Listening (Realtime)")
        case "audio", "audioDone", "clear", "mark":
            self.output.withLock { _ = $0.handleAudioEvent(event) }
            self.drainOutputEffects()
        case "transcript":
            self.handleTranscriptEvent(payload)
        case "toolCall":
            self.startToolCall(payload, lifecycleGeneration: lifecycleGeneration)
        case "error":
            let message = payload["message"]?.stringValue ?? String(localized: "Realtime failed")
            let issue = self.issue(message: message, payload: payload)
            self.logger.error("talk realtime: error=\(Self.safeLogMessage(message), privacy: .public)")
            self.hasReceivedFailure = true
            self.startupIssue = issue
            self.onIssue(issue)
            self.finishStartupWait(.failed(issue))
            self.onStatus(message)
        case "close":
            self.logger.debug("talk realtime: close")
            if self.hasReceivedReady {
                self.onStatus("Ready")
                let reason = payload["reason"]?.stringValue?.trimmedNonEmpty
                let talkEvent = payload["talkEvent"]?.dictionaryValue
                let termination: RealtimeTalkRelayTermination = if talkEvent?["type"]?.stringValue == "session.closed",
                                                                   talkEvent?["payload"]?.dictionaryValue?["reason"]?
                                                                       .stringValue == "output-cancelled",
                                                                       let cancellationReason = output
                                                                           .withLock({
                                                                               $0.terminalOutputCancellationReason
                                                                           })
                {
                    .outputCancelled(reason: cancellationReason)
                } else {
                    .remoteClose(reason: reason)
                }
                self.close(sendClose: false)
                self.onTermination(termination)
                return
            } else if !self.hasReceivedFailure {
                let issue = self.issue(
                    message: String(localized: "Realtime closed before it became ready."),
                    phase: "connect")
                self.onIssue(issue)
                self.startupIssue = issue
                self.finishStartupWait(.failed(issue))
                self.onStatus("Realtime failed before connecting")
            }
        default:
            return
        }
    }

    private func waitForStartupResult(
        timeoutSeconds: Int,
        lifecycleGeneration: UInt64) async -> StartupWaitResult
    {
        if self.isClosed { return .cancelled }
        if self.hasReceivedReady { return .ready }
        if let startupIssue { return .failed(startupIssue) }
        return await withCheckedContinuation { continuation in
            self.startupWaiter = continuation
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeoutSeconds)) * 1_000_000_000)
                self?.timeoutStartupWaiterIfNeeded(lifecycleGeneration: lifecycleGeneration)
            }
        }
    }

    private func drainPendingPreRelayEvents(lifecycleGeneration: UInt64) async {
        let pendingEvents = self.pendingPreRelayEvents
        self.pendingPreRelayEvents.removeAll()
        for event in pendingEvents {
            guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
            await self.handleGatewayEvent(event, lifecycleGeneration: lifecycleGeneration)
        }
    }

    private func finishStartupWait(_ result: StartupWaitResult) {
        guard let waiter = self.startupWaiter else { return }
        self.startupWaiter = nil
        waiter.resume(returning: result)
    }

    private func timeoutStartupWaiterIfNeeded(lifecycleGeneration: UInt64) {
        guard self.lifecycleGeneration == lifecycleGeneration,
              !self.isClosed,
              self.startupWaiter != nil,
              !self.hasReceivedReady,
              self.startupIssue == nil
        else {
            return
        }
        let issue = self.issue(
            message: String(localized: "Realtime did not become ready in time."),
            phase: "connect")
        self.hasReceivedFailure = true
        self.startupIssue = issue
        self.onIssue(issue)
        self.onStatus(issue.message)
        self.finishStartupWait(.failed(issue))
    }

    private func issue(
        code: String = "realtime_unavailable",
        message: String,
        phase: String? = nil,
        payload: [String: AnyCodable] = [:]) -> RealtimeTalkRelayIssue
    {
        RealtimeTalkRelayIssue(
            code: code,
            message: message,
            provider: payload["provider"]?.stringValue ?? self.options.provider,
            model: payload["model"]?.stringValue ?? self.options.model,
            transport: payload["transport"]?.stringValue ?? "gateway-relay",
            phase: payload["phase"]?.stringValue ?? phase)
    }

    private func handleInputLevelDuringOutput(_ rms: Float, timestampMs: Double) {
        let shouldCancel = self.output.withLock { output in
            guard output.isOutputPlaying, rms >= Self.bargeInRmsThreshold else { return false }
            if let outputStartedAtMs = output.outputStartedAtMs,
               timestampMs - outputStartedAtMs < Self.minOutputBeforeBargeInMs { return false }
            return timestampMs - self.lastBargeInAtMs >= Self.bargeInCooldownMs
        }
        guard shouldCancel else { return }
        self.lastBargeInAtMs = timestampMs
        self.cancelOutput(reason: "barge-in")
    }

    private func handleTranscriptEvent(_ payload: [String: AnyCodable]) {
        let isFinal = payload["final"]?.boolValue == true
        let role = payload["role"]?.stringValue ?? ""
        let text = payload["text"]?.stringValue ?? ""
        let charCount = text.count
        self.logger.debug(
            "talk realtime transcript: role=\(role.isEmpty ? "unknown" : role) final=\(isFinal) chars=\(charCount)")
        self.onTranscript(RealtimeTalkTranscript(role: role, text: text, isFinal: isFinal))
        guard isFinal else { return }
        if role == "user" {
            self.onStatus("Thinking…")
        } else if role == "assistant" {
            self.onStatus("Listening (Realtime)")
        }
    }

    private func handleToolCall(_ payload: [String: AnyCodable], lifecycleGeneration: UInt64) async {
        guard let relaySessionId,
              let callId = payload["callId"]?.stringValue,
              let name = payload["name"]?.stringValue
        else { return }
        self.onStatus("Thinking…")
        do {
            let result: [String: AnyCodable]
            if name == Self.agentControlToolName {
                result = try await self.agentControlToolResult(
                    relaySessionId: relaySessionId,
                    args: payload["args"],
                    lifecycleGeneration: lifecycleGeneration)
            } else {
                let completionStream = await self.transport.subscribeServerEvents(200)
                try await self.ensureCurrentLifecycle(lifecycleGeneration)
                let startPayload: [String: AnyCodable] = [
                    "sessionKey": AnyCodable(self.options.sessionKey),
                    "callId": AnyCodable(callId),
                    "name": AnyCodable(name),
                    "args": payload["args"] ?? AnyCodable([String: AnyCodable]()),
                    "relaySessionId": AnyCodable(relaySessionId),
                ]
                let startResponse = try await self.requestJSON(
                    method: "talk.client.toolCall",
                    payload: startPayload,
                    decodeAs: ToolCallStartResponse.self,
                    timeoutSeconds: 30,
                    lifecycleGeneration: lifecycleGeneration)
                guard let runId = startResponse.runId ?? startResponse.idempotencyKey else {
                    throw NSError(domain: "RealtimeTalkRelay", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: String(
                            localized: "Realtime tool call did not return a run id"),
                    ])
                }
                let completion = await self.waitForChatCompletion(
                    runId: runId,
                    stream: completionStream,
                    timeoutSeconds: 120)
                try await self.ensureCurrentLifecycle(lifecycleGeneration)
                result = completion.failed
                    ? ["error": AnyCodable("OpenClaw tool call failed")]
                    : ["text": AnyCodable(completion.text ?? "OpenClaw finished with no text.")]
            }
            try await self.submitToolResult(
                callId: callId,
                result: result,
                lifecycleGeneration: lifecycleGeneration)
            try await self.ensureCurrentLifecycle(lifecycleGeneration)
            self.onStatus("Listening (Realtime)")
        } catch {
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            let errorResult: [String: AnyCodable] = [
                "error": AnyCodable(error.localizedDescription),
            ]
            try? await self.submitToolResult(
                callId: callId,
                result: errorResult,
                lifecycleGeneration: lifecycleGeneration)
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            self.onStatus("Listening (Realtime)")
        }
    }

    private func startToolCall(_ payload: [String: AnyCodable], lifecycleGeneration: UInt64) {
        let taskID = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.toolCallTasks.removeValue(forKey: taskID) }
            await self.handleToolCall(payload, lifecycleGeneration: lifecycleGeneration)
        }
        self.toolCallTasks[taskID] = task
    }

    private func agentControlToolResult(
        relaySessionId: String,
        args: AnyCodable?,
        lifecycleGeneration: UInt64) async throws -> [String: AnyCodable]
    {
        let controlArgs = args?.dictionaryValue ?? [:]
        var payload: [String: AnyCodable] = [
            "sessionId": AnyCodable(relaySessionId),
            "sessionKey": AnyCodable(self.options.sessionKey),
            "text": AnyCodable(
                controlArgs["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "status"),
        ]
        if let mode = controlArgs["mode"]?.stringValue?.trimmedNonEmpty {
            payload["mode"] = AnyCodable(mode)
        }
        let response = try await self.requestJSON(
            method: "talk.session.steer",
            payload: payload,
            decodeAs: AnyCodable.self,
            timeoutSeconds: 30,
            lifecycleGeneration: lifecycleGeneration)
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        return response.dictionaryValue ?? ["result": response]
    }

    private func submitToolResult(
        callId: String,
        result: [String: AnyCodable],
        lifecycleGeneration: UInt64) async throws
    {
        guard let relaySessionId else { return }
        let payload: [String: AnyCodable] = [
            "sessionId": AnyCodable(relaySessionId),
            "callId": AnyCodable(callId),
            "result": AnyCodable(result),
        ]
        _ = try await self.requestJSON(
            method: "talk.session.submitToolResult",
            payload: payload,
            decodeAs: TalkSessionOkResult.self,
            timeoutSeconds: 30,
            lifecycleGeneration: lifecycleGeneration)
    }

    private func waitForChatCompletion(
        runId: String,
        stream: AsyncStream<EventFrame>,
        timeoutSeconds: Int) async -> ChatCompletionResult
    {
        await withTaskGroup(of: ChatCompletionResult.self) { group in
            group.addTask {
                for await event in stream {
                    if Task.isCancelled {
                        return ChatCompletionResult(text: nil, failed: true)
                    }
                    guard event.event == "chat",
                          let payload = event.payload,
                          let chatEvent = try? GatewayPayloadDecoding.decode(payload, as: RelayChatEvent.self),
                          chatEvent.runId == runId
                    else { continue }
                    if chatEvent.state == "final" {
                        return ChatCompletionResult(
                            text: Self.assistantText(from: chatEvent.message),
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

    private func requestJSON<T: Decodable>(
        method: String,
        payload: [String: AnyCodable],
        decodeAs type: T.Type,
        timeoutSeconds: Int,
        lifecycleGeneration: UInt64) async throws -> T
    {
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        let response = try await self.transport.request(method, payload, Double(timeoutSeconds * 1000))
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        return try JSONDecoder().decode(type, from: response)
    }

    private func lifecycleStatus(_ lifecycleGeneration: UInt64) async -> LifecycleStatus {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return .cancelledLocally }
        let routeIsCurrent = await self.transport.isCurrent()
        guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return .cancelledLocally }
        return routeIsCurrent ? .current : .routeLost
    }

    private func isCurrentLifecycle(_ lifecycleGeneration: UInt64) async -> Bool {
        await self.lifecycleStatus(lifecycleGeneration) == .current
    }

    private func isCurrentLifecycleLocally(_ lifecycleGeneration: UInt64) -> Bool {
        !Task.isCancelled && !self.isClosed && self.lifecycleGeneration == lifecycleGeneration
    }

    private func ensureCurrentLifecycle(_ lifecycleGeneration: UInt64) async throws {
        try Task.checkCancellation()
        guard await self.isCurrentLifecycle(lifecycleGeneration) else { throw CancellationError() }
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

    private nonisolated static func assistantText(from message: AnyCodable?) -> String? {
        guard let message else { return nil }
        if let text = message.stringValue {
            return text.trimmedNonEmpty
        }
        guard let object = message.dictionaryValue else { return nil }
        if let role = object["role"]?.stringValue?.trimmedNonEmpty, role.lowercased() != "assistant" {
            return nil
        }
        guard let content = object["content"] else { return nil }
        if let text = content.stringValue {
            return text.trimmedNonEmpty
        }
        let parts = content.arrayValue?.compactMap { part -> String? in
            if let text = part.stringValue { return text.trimmedNonEmpty }
            return part.dictionaryValue?["text"]?.stringValue?.trimmedNonEmpty
        } ?? []
        return parts.joined(separator: "\n").trimmedNonEmpty
    }
}

extension RealtimeTalkRelaySession {
    @discardableResult
    public func cancelOutput(reason: String = "user") -> Bool {
        guard reason != "barge-in" || self.supportsBargeIn == true else { return false }
        guard let relaySessionId else { return false }
        let turnId = self.output.withLock { output -> String? in
            guard let identity = output.outputIdentity, let turnId = identity.turnId else { return nil }
            output.terminalOutputCancellationReason = reason == "barge-in" ? nil : reason
            output.suppressedOutputIdentity = identity
            output.cancelledOutputTurnId = turnId
            output.awaitingOutputClear = true
            output.cancellationInFlight = true
            output.stopOutputPlayback()
            return turnId
        }
        guard let turnId else { return false }
        self.drainOutputEffects()
        self.outputCancellationGeneration &+= 1
        let cancellationGeneration = self.outputCancellationGeneration
        self.outputCancellationTask?.cancel()
        self.outputCancellationTask = Task { [weak self, transport] in
            let payload: [String: AnyCodable] = [
                "sessionId": AnyCodable(relaySessionId),
                "reason": AnyCodable(reason),
                "turnId": AnyCodable(turnId),
            ]
            do {
                let response = try await transport.request("talk.session.cancelOutput", payload, 8000)
                let result = try JSONDecoder().decode(TalkSessionCancelOutputResult.self, from: response)
                guard result.ok else { throw URLError(.badServerResponse) }
                guard let self, self.isCurrentOutputCancellation(cancellationGeneration) else { return }
                switch result.status?.stringValue {
                case "stale", "idle":
                    self.output.withLock { output in
                        output.terminalOutputCancellationReason = nil
                        output.acknowledgePlaybackMarks(output.takePendingPlaybackMarks())
                        output.retireCancellation()
                    }
                    self.retireOutputCancellationTask()
                case nil, "applied":
                    guard result.turnid == nil || result.turnid == turnId else {
                        throw URLError(.badServerResponse)
                    }
                    let retired = self.output.withLock { output in
                        output.cancellationInFlight = false
                        if output.awaitingOutputClear { return false }
                        output.retireCancellation()
                        return true
                    }
                    if retired {
                        self.retireOutputCancellationTask()
                    } else {
                        self.outputCancellationTask = nil
                    }
                default:
                    throw URLError(.badServerResponse)
                }
            } catch {
                guard let self, self.isCurrentOutputCancellation(cancellationGeneration) else { return }
                let issue = self.issue(
                    code: "realtime_output_cancel_failed",
                    message: String(
                        format: String(localized: "Realtime output cancellation failed: %@"),
                        error.localizedDescription),
                    phase: "output-cancel")
                self.onIssue(issue)
                self.onStatus(issue.message)
                // A failed current cancellation leaves remote output ownership unknown.
                // Keep the fence until terminal teardown makes late audio impossible.
                self.close(sendClose: true)
                self.onTermination(.outputCancellationFailed)
            }
        }
        return true
    }

    private func isCurrentOutputCancellation(_ generation: UInt64) -> Bool {
        generation == self.outputCancellationGeneration && !self.isClosed
    }

    private func handleOutputPlaybackFailure(_ message: String) {
        guard !self.isClosed else { return }
        let issue = self.issue(
            message: message,
            phase: "output-playback")
        self.onIssue(issue)
        self.onStatus(message)
        self.close(sendClose: true)
        self.onTermination(.outputPlaybackOverflow)
    }

    private func retireOutputCancellationTask() {
        self.outputCancellationGeneration &+= 1
        self.outputCancellationTask?.cancel()
        self.outputCancellationTask = nil
    }

    private func retireOutputCancellation() {
        self.output.withLock { $0.retireCancellation() }
        self.retireOutputCancellationTask()
    }
}

extension RealtimeTalkRelaySession {
    private func startMicrophonePump(lifecycleGeneration: UInt64) throws {
        self.stopMicrophonePump()
        guard !self.isInputPaused else { return }
        let audioCaptureGeneration = self.audioCaptureGeneration
        try self.audioCapture.start(
            targetSampleRate: self.inputSampleRateHz,
            onAudio: { [weak self] frame in
                Task { @MainActor [weak self] in
                    _ = self?.enqueueMicrophoneFrame(
                        frame.data,
                        timestampMs: frame.timestampMs,
                        rms: frame.rms,
                        lifecycleGeneration: lifecycleGeneration,
                        audioCaptureGeneration: audioCaptureGeneration)
                }
            },
            onFailure: { [weak self] message in
                self?.handleAudioInputFailure(
                    message,
                    lifecycleGeneration: lifecycleGeneration,
                    audioCaptureGeneration: audioCaptureGeneration)
            })
    }

    private func handleAudioInputFailure(
        _ message: String,
        lifecycleGeneration: UInt64,
        audioCaptureGeneration: UInt64)
    {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration),
              self.audioCaptureGeneration == audioCaptureGeneration
        else { return }
        let issue = self.issue(
            code: "audio_input_unavailable",
            message: message,
            phase: "audio-input")
        self.logger.error("talk realtime microphone failed: \(Self.safeLogMessage(message), privacy: .public)")
        self.onIssue(issue)
        self.onStatus(message)
        self.close(sendClose: true)
        self.onTermination(.audioInputFailed(message: message))
    }

    @discardableResult
    private func enqueueMicrophoneFrame(
        _ encoded: Data,
        timestampMs: Double,
        rms: Float,
        lifecycleGeneration: UInt64,
        audioCaptureGeneration: UInt64) -> Task<Void, Never>?
    {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration),
              self.audioCaptureGeneration == audioCaptureGeneration,
              !self.isInputPaused, self.output.withLock({ $0.suppressedOutputIdentity }) == nil,
              let audioSender
        else { return nil }
        self.recordMicrophoneFrame(byteCount: encoded.count, rms: rms, timestampMs: timestampMs)
        // Continuous providers own interruptions and need input throughout playback.
        if self.output.withLock({ $0.isOutputPlaying }), self.supportsBargeIn == true {
            if self.audioCapture.suppressesInputDuringOutput {
                self.recordSuppressedOutputEchoFrame(
                    byteCount: encoded.count,
                    rms: rms,
                    timestampMs: timestampMs)
                return nil
            }
            self.handleInputLevelDuringOutput(rms, timestampMs: timestampMs)
        }

        let taskID = UUID()
        let task = Task { @MainActor [weak self, audioSender] in
            guard let self else { return }
            defer { self.audioSendTasks.removeValue(forKey: taskID) }
            guard self.isCurrentLifecycleLocally(lifecycleGeneration),
                  self.audioCaptureGeneration == audioCaptureGeneration,
                  !self.isInputPaused, self.output.withLock({ $0.suppressedOutputIdentity }) == nil
            else { return }
            switch await audioSender.send(encoded, timestampMs: timestampMs) {
            case .sent, .inactive:
                return
            case .saturated:
                self.handleAudioInputFailure(
                    String(localized: "Realtime audio input fell behind. Reconnecting…"),
                    lifecycleGeneration: lifecycleGeneration,
                    audioCaptureGeneration: audioCaptureGeneration)
            case let .failed(message):
                self.handleAudioInputFailure(
                    String(format: String(localized: "Realtime audio failed: %@"), message),
                    lifecycleGeneration: lifecycleGeneration,
                    audioCaptureGeneration: audioCaptureGeneration)
            }
        }
        self.audioSendTasks[taskID] = task
        return task
    }

    private func recordMicrophoneFrame(byteCount: Int, rms: Float, timestampMs: Double) {
        guard !self.isClosed else { return }
        self.onInputLevel(TalkAudioLevel.normalized(rms: Double(rms)))
        self.micLogFrameCount += 1
        self.micLogByteCount += byteCount
        self.micLogMaxRms = max(self.micLogMaxRms, rms)
        guard timestampMs - self.lastMicLogAtMs >= 1000 else { return }
        self.lastMicLogAtMs = timestampMs
        let maxRms = String(format: "%.4f", Double(self.micLogMaxRms))
        self.logger.debug(
            "talk realtime mic: buffers=\(self.micLogFrameCount) bytes=\(self.micLogByteCount) maxRms=\(maxRms)")
        self.micLogFrameCount = 0
        self.micLogByteCount = 0
        self.micLogMaxRms = 0
    }

    private func recordSuppressedOutputEchoFrame(byteCount: Int, rms: Float, timestampMs: Double) {
        self.suppressedEchoFrameCount += 1
        self.suppressedEchoByteCount += byteCount
        self.suppressedEchoMaxRms = max(self.suppressedEchoMaxRms, rms)
        guard timestampMs - self.lastSuppressedEchoLogAtMs >= 1000 else { return }
        self.lastSuppressedEchoLogAtMs = timestampMs
        let maxRms = String(format: "%.4f", Double(self.suppressedEchoMaxRms))
        let frames = self.suppressedEchoFrameCount
        let bytes = self.suppressedEchoByteCount
        self.logger.debug(
            "talk realtime mic suppressed during output: buffers=\(frames) bytes=\(bytes) maxRms=\(maxRms)")
        self.suppressedEchoFrameCount = 0
        self.suppressedEchoByteCount = 0
        self.suppressedEchoMaxRms = 0
    }

    private func stopMicrophonePump() {
        self.audioCaptureGeneration &+= 1
        for task in self.audioSendTasks.values {
            task.cancel()
        }
        self.audioSendTasks.removeAll()
        self.audioCapture.stop()
    }
}

#if DEBUG
extension RealtimeTalkRelaySession {
    // periphery:ignore - package tests drive a relay session without a live gateway handshake.
    func _test_setRelaySessionId(_ relaySessionId: String) {
        self.relaySessionId = relaySessionId
        self.output.withLock { $0.relaySessionId = relaySessionId }
    }

    // periphery:ignore - package tests inject gateway events without a live socket.
    func _test_handleGatewayEvent(_ event: EventFrame) async {
        await self.handleGatewayEvent(event, lifecycleGeneration: self.lifecycleGeneration)
    }

    // periphery:ignore - package tests end the event stream deterministically.
    func _test_handleEventStreamEnded() async {
        await self.handleEventStreamEnded(lifecycleGeneration: self.lifecycleGeneration)
    }

    // periphery:ignore - package tests observe startup cancellation without waiting out the timeout.
    func _test_waitForStartupCancelled(timeoutSeconds: Int) async -> Bool {
        if case .cancelled = await self.waitForStartupResult(
            timeoutSeconds: timeoutSeconds,
            lifecycleGeneration: self.lifecycleGeneration)
        {
            return true
        }
        return false
    }

    // periphery:ignore - package tests await in-flight tool calls before asserting.
    func _test_waitForToolCalls() async {
        let tasks = self.toolCallTasks.values
        for task in tasks {
            await task.value
        }
    }

    // periphery:ignore - package tests capture the exact owned cancellation before replacement or stop.
    func _test_outputCancellationTask() -> Task<Void, Never>? {
        self.outputCancellationTask
    }

    // periphery:ignore - package tests start output playback without decoding real audio.
    func _test_markOutputAudioStarted(nowMs: Double) {
        self.output.withLock { $0.markOutputAudioStarted(nowMs: nowMs) }
    }

    // periphery:ignore - package tests finish playback without a real player callback.
    func _test_markOutputPlaybackFinished() {
        self.output.withLock { $0.markOutputPlaybackFinished() }
        self.drainOutputEffects()
    }

    // periphery:ignore - package tests observe barge-in timing state.
    func _test_outputStartedAtMs() -> Double? {
        self.output.withLock { $0.outputStartedAtMs }
    }

    // periphery:ignore - package tests observe playback state without exposing it publicly.
    nonisolated func _test_isOutputPlaying() -> Bool {
        self.output.withLock { $0.isOutputPlaying }
    }

    // periphery:ignore - package tests exercise the audio sender without a started session.
    func _test_prepareAudioSender(relaySessionId: String) {
        self.isClosed = false
        self.audioSender = RealtimeAudioSender(
            relaySessionId: relaySessionId,
            request: self.transport.request)
    }

    // periphery:ignore - package tests enqueue frames without a live capture device.
    func _test_enqueueMicrophoneFrame(
        _ data: Data,
        timestampMs: Double = 1) -> Task<Void, Never>?
    {
        self.enqueueMicrophoneFrame(
            data,
            timestampMs: timestampMs,
            rms: 0.01,
            lifecycleGeneration: self.lifecycleGeneration,
            audioCaptureGeneration: self.audioCaptureGeneration)
    }

    // periphery:ignore - package tests start the pump to observe capture failure handling.
    func _test_startMicrophonePump() throws {
        try self.startMicrophonePump(lifecycleGeneration: self.lifecycleGeneration)
    }
}
#endif
#endif
