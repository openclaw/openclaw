@preconcurrency import AVFoundation
import Foundation
import OSLog

/// Fixed-capacity ring buffer for audio samples; avoids O(n) removeFirst when appending.
private final class AudioRingBuffer: @unchecked Sendable {
    private let buffer: UnsafeMutableBufferPointer<Float>
    private let capacity: Int
    private var writeIndex: Int = 0
    private var totalCount: Int = 0

    init(capacity: Int) {
        self.capacity = capacity
        self.buffer = UnsafeMutableBufferPointer.allocate(capacity: capacity)
        self.buffer.initialize(repeating: 0)
    }

    deinit {
        buffer.deallocate()
    }

    var count: Int { min(totalCount, capacity) }

    func append(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        for s in samples {
            buffer[writeIndex] = s
            writeIndex = (writeIndex + 1) % capacity
            totalCount += 1
        }
    }

    /// Last `n` samples (newest at end). Returns [] if n <= 0 or no data.
    func suffix(_ n: Int) -> [Float] {
        let c = count
        let take = min(n, c)
        guard take > 0 else { return [] }
        var result = [Float]()
        result.reserveCapacity(take)
        let start = (writeIndex - take + capacity) % capacity
        for i in 0..<take {
            result.append(buffer[(start + i) % capacity])
        }
        return result
    }

    func removeAll() {
        writeIndex = 0
        totalCount = 0
    }
}

/// Thread-safe single-use flag for the converter callback (Sendable-safe capture).
private final class ConsumedState: @unchecked Sendable {
    private let lock = NSLock()
    private var consumed = false
    /// Returns true only the first time; thereafter returns false.
    func consume() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if consumed { return false }
        consumed = true
        return true
    }
}

/// Swift actor that bridges Talk Mode directly to the embedded ExecuTorch runtime
/// through Voxtral's C API (no subprocess runner).
///
/// Audio pipeline: Mic -> AVAudioEngine -> 16kHz mono float -> streaming session feed -> tokens callback
actor ExecuTorchSTTBridge {
    static let shared = ExecuTorchSTTBridge()

    private static let modelCandidates = [
        "model-metal-fpa4w-streaming.pte",
        "model-metal-int4-streaming.pte",
        "model-streaming.pte",
    ]
    private static let preprocessorCandidates = [
        "preprocessor-streaming.pte",
        "preprocessor.pte",
    ]

    private let logger = Logger(subsystem: "ai.openclaw", category: "executorch.stt")
    private static let verboseLogging = ProcessInfo.processInfo.environment["OPENCLAW_EXECUTORCH_DEBUG"] == "1"

    enum State: Sendable, Equatable {
        case idle
        case loading
        case ready
        case listening
        case error(String)
    }

    private var runtime: VxrtRuntimeHandle?
    private var runner: VxrtRunnerRef?
    private var streamingController: VxrtStreamingController?
    private var audioEngine: AVAudioEngine?
    private var state: State = .idle
    private var transcriptBuffer = ""
    private var onTranscript: ((String, Bool) -> Void)?
    private var rollingBuffer: AudioRingBuffer?
    private static let rollingBufferCapacity = 16_000 * 30
    private var offlinePollTask: Task<Void, Never>?
    private var fallbackWatchdogTask: Task<Void, Never>?
    private var observedTokenCount = 0
    private var observedChunkCount = 0
    private var offlineFallbackActive = false
    private var lastOfflineTranscript = ""

    // Latency measurement (baseline and tuning validation)
    private var sessionStartTime: CFAbsoluteTime?
    private var minSamplesReadyTime: CFAbsoluteTime?
    private var hasEmittedFirstTokenThisSession = false
    private var firstTokenEmitTime: CFAbsoluteTime?
    private var recentFirstTokenLatencies: [Double] = []
    private var recentFinalizeLatencies: [Double] = []
    private static let maxLatencySamples = 32

    // VAD/energy gate: skip decode when audio is quiet to save compute
    private var rollingRMS: Double = 0
    private var quietFrameCount: Int = 0
    private var lastProbeTime: CFAbsoluteTime = 0
    private static let rmsAlpha = 0.1
    private static let rmsThreshold: Float = 0.008
    private static let maxQuietFramesBeforeProbe = 40 // ~2s at 200ms poll
    private static let minProbeIntervalSeconds = 1.2

    // Poll cadence (nanoseconds)
    private static let pollIntervalBootstrapNs: UInt64 = 280_000_000   // 280ms before first transcript
    private static let pollIntervalActiveNs: UInt64 = 400_000_000     // 400ms when we have transcript
    private static let pollIntervalIdleNs: UInt64 = 800_000_000       // 800ms when quiet
    private static let minOfflineWindowSamples = 16_000                // 1s at 16kHz
    private static let maxOfflineWindowSamples = 32_000               // 2s (was 6s)
    private var isPolling = false

    /// When false, capture and poll continue but no transcript is forwarded (used during TTS to avoid echo).
    private var emissionEnabled = true

    var isAvailable: Bool {
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    var currentState: State { state }

    // MARK: - Configuration

    private var runtimeLibraryPath: String {
        if let envPath = ProcessInfo.processInfo.environment["OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !envPath.isEmpty
        {
            return (envPath as NSString).expandingTildeInPath
        }
        if let bundled = Bundle.main.resourcePath {
            let bundledRuntime = "\(bundled)/libvoxtral_realtime_runtime.dylib"
            if FileManager.default.fileExists(atPath: bundledRuntime) {
                return bundledRuntime
            }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.openclaw/lib/libvoxtral_realtime_runtime.dylib"
    }

    private var modelDir: String {
        if let bundled = Bundle.main.resourcePath {
            if Self.modelCandidates.contains(where: {
                FileManager.default.fileExists(atPath: "\(bundled)/\($0)")
            }) {
                return bundled
            }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.openclaw/models/voxtral/voxtral-realtime-metal"
    }

    var modelPath: String {
        if let resolved = Self.resolveExistingPath(in: modelDir, candidates: Self.modelCandidates) {
            return resolved
        }
        return "\(modelDir)/model-metal-fpa4w-streaming.pte"
    }

    var tokenizerPath: String { "\(modelDir)/tekken.json" }

    var preprocessorPath: String {
        if let resolved = Self.resolveExistingPath(in: modelDir, candidates: Self.preprocessorCandidates) {
            return resolved
        }
        return "\(modelDir)/preprocessor-streaming.pte"
    }

    /// True if the resolved preprocessor is the streaming one (required for streaming session tokens).
    private var isUsingStreamingPreprocessor: Bool {
        (preprocessorPath as NSString).lastPathComponent == "preprocessor-streaming.pte"
    }

    // MARK: - Health Check

    func checkAvailability() -> (available: Bool, missing: [String]) {
        var missing: [String] = []
        let paths = [
            ("Runtime", runtimeLibraryPath),
            ("Model", modelPath),
            ("Tokenizer", tokenizerPath),
            ("Preprocessor", preprocessorPath),
        ]
        for (label, path) in paths where !FileManager.default.fileExists(atPath: path) {
            missing.append("\(label): \(path)")
        }
        return (missing.isEmpty, missing)
    }

    // MARK: - Runtime Lifecycle

    func loadModel() async throws {
        logger.info("executorch.stt: loadModel() entered, state=\(String(describing: self.state))")
        guard case .idle = state else {
            if case .ready = state {
                logger.info("executorch.stt: loadModel() already ready, skipping")
                return
            }
            if case .listening = state {
                logger.info("executorch.stt: loadModel() already listening, skipping")
                return
            }
            logger.error("executorch.stt: loadModel() invalid state, throwing alreadyRunning")
            throw ExecuTorchError.alreadyRunning
        }

        let runtimePath = runtimeLibraryPath
        let modelPathResolved = modelPath
        logger.info("executorch.stt: paths — runtime=\(runtimePath, privacy: .public) model=\(modelPathResolved, privacy: .public) tokenizer=\(tokenizerPath, privacy: .public) preprocessor=\(preprocessorPath, privacy: .public)")
        let modelFile = (modelPathResolved as NSString).lastPathComponent
        let preprocessorFile = (preprocessorPath as NSString).lastPathComponent
        if !modelFile.contains("streaming") {
            logger.warning(
                "executorch.stt: model file does not look like streaming export: \(modelFile, privacy: .public)")
        }
        if !isUsingStreamingPreprocessor {
            let msg =
                "Talk Mode requires preprocessor-streaming.pte for streaming transcription. Only \(preprocessorFile, privacy: .public) was found in \(modelDir, privacy: .public). Add preprocessor-streaming.pte (e.g. run 'pnpm openclaw executorch setup --backend metal' or download from the model repo) and retry."
            logger.error("executorch.stt: \(msg)")
            state = .error(msg)
            throw ExecuTorchError.filesNotFound(msg)
        }
        let check = checkAvailability()
        guard check.available else {
            let msg = "Missing: \(check.missing.joined(separator: ", "))"
            logger.error("executorch.stt: availability check failed — \(msg, privacy: .public)")
            state = .error(msg)
            throw ExecuTorchError.filesNotFound(msg)
        }
        logger.info("executorch.stt: availability check OK")

        state = .loading
        logger.info("executorch.stt: loading embedded runtime from \(runtimePath, privacy: .public)...")
        do {
            let runtime = try VxrtRuntimeHandle.load(libraryPath: runtimePath)
            logger.info("executorch.stt: runtime loaded, creating runner...")
            let runner = try runtime.createRunner(
                modelPath: modelPathResolved,
                tokenizerPath: tokenizerPath,
                preprocessorPath: preprocessorPath,
                warmup: true)
            self.runtime = runtime
            self.runner = runner
            self.setReady()
            logger.info("executorch.stt: loadModel() complete — ready")
        } catch {
            let message = error.localizedDescription
            logger.error("executorch.stt: loadModel failed — \(message, privacy: .public)")
            self.state = .error(message)
            self.runner = nil
            self.runtime = nil
            throw error
        }
    }

    // MARK: - Audio Capture

    func startListening(onTranscript: @escaping (String, Bool) -> Void) throws {
        logger.info("executorch.stt: startListening() entered, state=\(String(describing: self.state))")
        guard case .ready = state else {
            logger.error("executorch.stt: startListening() not ready, state=\(String(describing: self.state))")
            throw ExecuTorchError.notReady
        }
        guard runtime != nil, runner != nil else {
            logger.error("executorch.stt: startListening() runtime or runner nil")
            throw ExecuTorchError.notReady
        }

        self.onTranscript = onTranscript
        if self.rollingBuffer == nil {
            self.rollingBuffer = AudioRingBuffer(capacity: Self.rollingBufferCapacity)
        }
        self.rollingBuffer?.removeAll()
        self.observedTokenCount = 0
        self.observedChunkCount = 0
        self.offlineFallbackActive = false
        self.lastOfflineTranscript = ""
        self.offlinePollTask?.cancel()
        self.offlinePollTask = nil
        self.fallbackWatchdogTask?.cancel()
        self.fallbackWatchdogTask = nil
        self.streamingController?.stop(flush: false)
        self.streamingController = nil

        let useStreaming = ProcessInfo.processInfo.environment["OPENCLAW_EXECUTORCH_USE_STREAMING"] == "1"
        if useStreaming {
            guard let runtime = self.runtime, let runner = self.runner else {
                logger.error("executorch.stt: streaming requested but runtime/runner missing")
                throw ExecuTorchError.notReady
            }
            do {
                let bridge = self
                let controller = try runtime.createStreamingController(
                    runner: runner,
                    onToken: { piece in
                        Task { await bridge.handleStreamingToken(piece) }
                    },
                    onError: { message in
                        Task { await bridge.handleStreamingError(message) }
                    })
                self.streamingController = controller
                logger.info("executorch.stt: OPENCLAW_EXECUTORCH_USE_STREAMING=1 — streaming session active")
            } catch {
                logger.error(
                    "executorch.stt: streaming session init failed, will fallback to offline-poll: \(error.localizedDescription, privacy: .public)")
            }
        }
        if !useStreaming {
            logger.info("executorch.stt: streaming disabled; using offline-poll transcription")
        }

        let bridge = self
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)
        logger.info("executorch.stt: audio hwFormat sampleRate=\(hwFormat.sampleRate) channels=\(hwFormat.channelCount)")
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            logger.error("executorch.stt: invalid hw format — microphone not available")
            throw ExecuTorchError.microphoneNotAvailable
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false)
        else {
            throw ExecuTorchError.audioConversionFailed
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            logger.error("executorch.stt: AVAudioConverter creation failed")
            throw ExecuTorchError.audioConversionFailed
        }
        logger.info("executorch.stt: installing tap, starting audio engine...")

        let sampleRateRatio = 16_000.0 / hwFormat.sampleRate
        var enqueueCount = 0
        let logEnqueue = logger
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
            let consumedState = ConsumedState()
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRateRatio) + 1
            guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
                return
            }

            converter.convert(to: converted, error: nil) { _, outStatus in
                if consumedState.consume() {
                    outStatus.pointee = .haveData
                    return buffer
                }
                outStatus.pointee = .noDataNow
                return nil
            }

            guard
                converted.frameLength > 0,
                let channelData = converted.floatChannelData
            else {
                return
            }
            let frameCount = Int(converted.frameLength)
            enqueueCount += 1
            if enqueueCount == 1 || enqueueCount % 50 == 0 {
                logEnqueue.info("executorch.stt: enqueue chunk \(enqueueCount) samples=\(frameCount)")
            }
            let sampleSlice = UnsafeBufferPointer(start: channelData[0], count: frameCount)
            let chunk = Array(sampleSlice)
            Task { await bridge.recordAudioChunk(chunk) }
        }

        do {
            try engine.start()
            logger.info("executorch.stt: audio engine started — listening")
        } catch {
            logger.error("executorch.stt: audio engine start failed — \(error.localizedDescription, privacy: .public)")
            inputNode.removeTap(onBus: 0)
            throw ExecuTorchError.launchFailed("Audio engine start failed: \(error.localizedDescription)")
        }

        self.audioEngine = engine
        self.state = .listening
        self.sessionStartTime = CFAbsoluteTimeGetCurrent()
        self.minSamplesReadyTime = nil
        self.hasEmittedFirstTokenThisSession = false
        self.firstTokenEmitTime = nil
        self.rollingRMS = 0
        self.quietFrameCount = 0
        self.lastProbeTime = 0
        self.emissionEnabled = true

        if self.streamingController == nil {
            self.activateOfflineFallback(reason: useStreaming ? "streaming unavailable" : "streaming disabled")
        }

        logger.info(
            "executorch.stt: startListening() complete — state=listening (\(self.offlineFallbackActive ? "offline poll active" : "streaming active"))")
    }

    func stopListening() {
        self.audioEngine?.inputNode.removeTap(onBus: 0)
        self.audioEngine?.stop()
        self.audioEngine = nil

        self.fallbackWatchdogTask?.cancel()
        self.fallbackWatchdogTask = nil
        self.streamingController?.stop(flush: false)
        self.streamingController = nil
        self.offlinePollTask?.cancel()
        self.offlinePollTask = nil
        self.offlineFallbackActive = false
        self.lastOfflineTranscript = ""
        self.rollingBuffer?.removeAll()
        self.onTranscript = nil
        self.sessionStartTime = nil
        self.minSamplesReadyTime = nil
        self.hasEmittedFirstTokenThisSession = false
        self.firstTokenEmitTime = nil

        if case .listening = self.state {
            self.state = .ready
        }
        logger.info("ExecuTorch STT stopped listening")
    }

    func shutdown() {
        self.stopListening()
        if let runtime, let runner {
            runtime.destroyRunner(runner)
        }
        self.runner = nil
        self.runtime = nil
        self.state = .idle
        self.transcriptBuffer = ""
        logger.info("ExecuTorch STT shutdown")
    }

    // MARK: - Private

    private func setReady() {
        self.state = .ready
        logger.info("ExecuTorch model loaded — ready")
    }

    private func setError(_ message: String) {
        self.state = .error(message)
        logger.error("ExecuTorch error: \(message, privacy: .public)")
    }

    private func handleStreamingError(_ message: String) {
        if case .listening = self.state {
            self.activateOfflineFallback(reason: "streaming error: \(message)")
            return
        }
        self.stopListening()
        self.setError(message)
    }

    func getAndClearTranscript() -> String {
        let result = transcriptBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptBuffer = ""
        return result
    }

    private static func resolveExistingPath(in dir: String, candidates: [String]) -> String? {
        for candidate in candidates {
            let fullPath = "\(dir)/\(candidate)"
            if FileManager.default.fileExists(atPath: fullPath) {
                return fullPath
            }
        }
        return nil
    }

    private func recordAudioChunk(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        guard let buf = self.rollingBuffer else { return }
        self.observedChunkCount += 1
        buf.append(samples)
        let rms = Self.rms(samples)
        self.rollingRMS = Self.rmsAlpha * rms + (1 - Self.rmsAlpha) * self.rollingRMS
        if self.observedChunkCount == 1 || self.observedChunkCount % 50 == 0 {
            logger.info(
                "executorch.stt: observe chunkCount=\(self.observedChunkCount) tokenCount=\(self.observedTokenCount) rollingSamples=\(buf.count)")
        }

        if let streamingController = self.streamingController {
            streamingController.enqueue(samples: samples)
        }

        guard self.offlineFallbackActive else { return }
        if self.minSamplesReadyTime == nil, buf.count >= Self.minOfflineWindowSamples {
            self.minSamplesReadyTime = CFAbsoluteTimeGetCurrent()
            Task { await self.pollOfflineTranscribeOnce(force: true) }
        }
    }

    /// Turn transcript emission on or off. Capture keeps running; used during TTS to avoid echo without tearing down.
    func setEmissionEnabled(_ enabled: Bool) {
        self.emissionEnabled = enabled
        logger.info("executorch.stt: emission \(enabled ? "enabled" : "disabled")")
    }

    /// Call from TalkModeRuntime when finalizing transcript (before stopRecognition). Records latency for p50/p90.
    func recordFinalizeLatency() {
        guard let start = sessionStartTime else { return }
        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
        recentFinalizeLatencies.append(elapsed)
        if recentFinalizeLatencies.count > Self.maxLatencySamples {
            recentFinalizeLatencies.removeFirst()
        }
        logLatencyStats()
    }

    /// Attempt one last offline decode before finalization to capture tail words.
    /// Returns only newly discovered text since the last successful offline decode.
    func forceFinalOfflineDecodeDelta() -> String {
        guard case .listening = self.state else { return "" }
        guard self.offlineFallbackActive else { return "" }
        self.offlinePollTask?.cancel()
        self.offlinePollTask = nil
        let maxNewTokens: Int32 = self.hasEmittedFirstTokenThisSession ? 24 : 32
        return self.decodeOfflineDelta(maxNewTokens: maxNewTokens, force: true) ?? ""
    }

    private func logLatencyStats() {
        let first = recentFirstTokenLatencies.sorted()
        let finalize = recentFinalizeLatencies.sorted()
        let p50First = Self.percentile(first, 0.5)
        let p90First = Self.percentile(first, 0.9)
        let p50Final = Self.percentile(finalize, 0.5)
        let p90Final = Self.percentile(finalize, 0.9)
        logger.info(
            "executorch.stt: latency firstToken p50=\(String(format: "%.0f", p50First ?? 0))ms p90=\(String(format: "%.0f", p90First ?? 0))ms n=\(first.count) | finalize p50=\(String(format: "%.0f", p50Final ?? 0))ms p90=\(String(format: "%.0f", p90Final ?? 0))ms n=\(finalize.count)")
    }

    private static func percentile(_ sorted: [Double], _ p: Double) -> Double? {
        guard !sorted.isEmpty else { return nil }
        let index = Int(Double(sorted.count) * p)
        let i = min(index, sorted.count - 1)
        return sorted[i]
    }

    /// Returns true if we emitted transcript this poll (for adaptive cadence).
    private func pollOfflineTranscribeOnce(force: Bool = false) -> Bool {
        let maxNewTokens: Int32 = self.hasEmittedFirstTokenThisSession ? 16 : 24
        guard let delta = self.decodeOfflineDelta(maxNewTokens: maxNewTokens, force: force) else { return false }
        if Self.verboseLogging {
            logger.info("executorch.stt: offline emitted \(delta.count) chars: \"\(delta.prefix(80), privacy: .public)\"")
        }
        if self.emissionEnabled {
            self.transcriptBuffer += delta
            self.onTranscript?(delta, false)
            return true
        }
        return false
    }

    private func decodeOfflineDelta(maxNewTokens: Int32, force: Bool) -> String? {
        guard case .listening = self.state else { return nil }
        guard self.offlineFallbackActive else { return nil }
        guard let runtime = self.runtime, let runner = self.runner else { return nil }
        guard let buf = self.rollingBuffer else { return nil }
        guard !self.isPolling else { return nil }

        if !force, buf.count < Self.minOfflineWindowSamples {
            return nil
        }

        let now = CFAbsoluteTimeGetCurrent()
        if !force {
            let isQuiet = self.rollingRMS < Double(Self.rmsThreshold)
            if isQuiet {
                self.quietFrameCount += 1
                let timeSinceProbe = now - self.lastProbeTime
                if self.quietFrameCount < Self.maxQuietFramesBeforeProbe, timeSinceProbe < Self.minProbeIntervalSeconds {
                    return nil
                }
            } else {
                self.quietFrameCount = 0
            }
        }
        self.lastProbeTime = now

        self.isPolling = true
        defer { self.isPolling = false }

        let windowSamples = min(buf.count, Self.maxOfflineWindowSamples)
        guard windowSamples > 0 else { return nil }
        let samples = buf.suffix(windowSamples)
        let prevLen = self.lastOfflineTranscript.count
        if Self.verboseLogging {
            logger.info("executorch.stt: offline poll begin samples=\(samples.count) previousChars=\(prevLen) maxNewTokens=\(maxNewTokens)")
        }

        let t0 = CFAbsoluteTimeGetCurrent()
        do {
            let transcript = Self.cleanModelOutput(
                try runtime.transcribe(runner: runner, samples: samples, maxNewTokens: maxNewTokens))
            let elapsed = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            if Self.verboseLogging {
                logger.info("executorch.stt: offline poll done in \(String(format: "%.0f", elapsed))ms chars=\(transcript.count)")
            }
            guard !transcript.isEmpty else { return nil }
            let delta = Self.cleanModelOutput(
                Self.deltaSuffix(previous: self.lastOfflineTranscript, current: transcript))
            self.lastOfflineTranscript = transcript
            guard !delta.isEmpty else { return nil }
            if !self.hasEmittedFirstTokenThisSession, let start = self.sessionStartTime {
                self.hasEmittedFirstTokenThisSession = true
                self.firstTokenEmitTime = CFAbsoluteTimeGetCurrent()
                let firstTokenMs = (self.firstTokenEmitTime! - start) * 1000
                self.recentFirstTokenLatencies.append(firstTokenMs)
                if self.recentFirstTokenLatencies.count > Self.maxLatencySamples {
                    self.recentFirstTokenLatencies.removeFirst()
                }
                self.logLatencyStats()
            }
            return delta
        } catch {
            let elapsed = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            logger.error(
                "executorch.stt: offline transcribe failed after \(String(format: "%.0f", elapsed))ms — \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func handleStreamingToken(_ piece: String) {
        guard case .listening = self.state else { return }
        let cleaned = Self.cleanStreamingPiece(piece)
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.observedTokenCount += 1
        if !self.hasEmittedFirstTokenThisSession, let start = self.sessionStartTime {
            self.hasEmittedFirstTokenThisSession = true
            self.firstTokenEmitTime = CFAbsoluteTimeGetCurrent()
            let firstTokenMs = (self.firstTokenEmitTime! - start) * 1000
            self.recentFirstTokenLatencies.append(firstTokenMs)
            if self.recentFirstTokenLatencies.count > Self.maxLatencySamples {
                self.recentFirstTokenLatencies.removeFirst()
            }
            self.logLatencyStats()
        }
        if self.emissionEnabled {
            self.transcriptBuffer += cleaned
            self.onTranscript?(cleaned, false)
        }
    }

    private func startOfflinePollTask() {
        self.offlinePollTask?.cancel()
        self.offlinePollTask = Task { [weak self] in
            guard let self else { return }
            var intervalNs = Self.pollIntervalBootstrapNs
            while true {
                try? await Task.sleep(nanoseconds: intervalNs)
                if Task.isCancelled { return }
                let hadTranscript = await self.pollOfflineTranscribeOnce()
                intervalNs = hadTranscript ? Self.pollIntervalActiveNs : Self.pollIntervalIdleNs
            }
        }
    }

    private func activateOfflineFallback(reason: String) {
        if self.offlineFallbackActive {
            return
        }
        logger.warning("executorch.stt: switching to offline-poll fallback: \(reason, privacy: .public)")
        self.streamingController?.stop(flush: false)
        self.streamingController = nil
        self.offlineFallbackActive = true
        self.lastOfflineTranscript = ""
        self.startOfflinePollTask()
        if let buf = self.rollingBuffer, buf.count >= Self.minOfflineWindowSamples {
            _ = self.pollOfflineTranscribeOnce(force: true)
        }
    }

    private static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for s in samples {
            sum += Double(s * s)
        }
        return (sum / Double(samples.count)).squareRoot()
    }

    /// Strip Voxtral special tokens and noise from raw model output.
    private static func cleanModelOutput(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "</s>", with: "")
            .replacingOccurrences(of: "<s>", with: "")
            .replacingOccurrences(of: "<unk>", with: "")
            .replacingOccurrences(of: "[STREAMING_PAD]", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Streaming callback pieces should keep intra-token spaces; trim only after consumption.
    private static func cleanStreamingPiece(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "</s>", with: "")
            .replacingOccurrences(of: "<s>", with: "")
            .replacingOccurrences(of: "<unk>", with: "")
            .replacingOccurrences(of: "[STREAMING_PAD]", with: "")
    }

    private static func deltaSuffix(previous: String, current: String) -> String {
        guard !current.isEmpty else { return "" }
        guard !previous.isEmpty else { return current }
        if current == previous { return "" }
        if current.hasPrefix(previous) {
            return String(current.dropFirst(previous.count))
        }
        if previous.hasPrefix(current) {
            return ""
        }
        let previousChars = Array(previous)
        let currentChars = Array(current)
        let maxOverlap = min(previousChars.count, currentChars.count)
        if maxOverlap > 0 {
            for overlap in stride(from: maxOverlap, through: 1, by: -1) {
                if previousChars.suffix(overlap).elementsEqual(currentChars.prefix(overlap)) {
                    return String(currentChars.dropFirst(overlap))
                }
            }
        }
        if previous.contains(current) {
            return ""
        }
        return current
    }
}

#if DEBUG
extension ExecuTorchSTTBridge {
    nonisolated static func _testDeltaSuffix(previous: String, current: String) -> String {
        deltaSuffix(previous: previous, current: current)
    }
}
#endif

// MARK: - Error Types

enum ExecuTorchError: Error, LocalizedError {
    case filesNotFound(String)
    case launchFailed(String)
    case notReady
    case alreadyRunning
    case microphoneNotAvailable
    case audioConversionFailed

    var errorDescription: String? {
        switch self {
        case .filesNotFound(let detail): return "ExecuTorch files not found: \(detail)"
        case .launchFailed(let detail): return "Failed to launch runtime: \(detail)"
        case .notReady: return "Runtime not ready"
        case .alreadyRunning: return "Runtime already running"
        case .microphoneNotAvailable: return "No microphone available"
        case .audioConversionFailed: return "Audio format conversion failed"
        }
    }
}
