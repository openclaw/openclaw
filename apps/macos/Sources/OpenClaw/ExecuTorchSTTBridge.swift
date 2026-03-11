@preconcurrency import AVFoundation
import Foundation
import OSLog

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
        guard case .idle = state else {
            if case .ready = state { return }
            if case .listening = state { return }
            throw ExecuTorchError.alreadyRunning
        }

        let check = checkAvailability()
        guard check.available else {
            let msg = "Missing: \(check.missing.joined(separator: ", "))"
            state = .error(msg)
            throw ExecuTorchError.filesNotFound(msg)
        }

        state = .loading
        logger.info("Loading embedded ExecuTorch runtime...")
        do {
            let runtime = try VxrtRuntimeHandle.load(libraryPath: runtimeLibraryPath)
            let runner = try runtime.createRunner(
                modelPath: modelPath,
                tokenizerPath: tokenizerPath,
                preprocessorPath: preprocessorPath,
                warmup: true)
            self.runtime = runtime
            self.runner = runner
            self.setReady()
        } catch {
            let message = error.localizedDescription
            self.state = .error(message)
            self.runner = nil
            self.runtime = nil
            throw error
        }
    }

    // MARK: - Audio Capture

    func startListening(onTranscript: @escaping (String, Bool) -> Void) throws {
        guard case .ready = state else {
            throw ExecuTorchError.notReady
        }
        guard let runtime, let runner else {
            throw ExecuTorchError.notReady
        }

        self.onTranscript = onTranscript
        let bridge = self
        let controller = try runtime.createStreamingController(
            runner: runner,
            onToken: { [weak bridge] piece in
                guard let bridge else { return }
                Task { await bridge.handleToken(piece) }
            },
            onError: { [weak bridge] message in
                guard let bridge else { return }
                Task { await bridge.handleStreamingError(message) }
            })

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            controller.stop(flush: false)
            throw ExecuTorchError.microphoneNotAvailable
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false)
        else {
            controller.stop(flush: false)
            throw ExecuTorchError.audioConversionFailed
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            controller.stop(flush: false)
            throw ExecuTorchError.audioConversionFailed
        }

        let sampleRateRatio = 16_000.0 / hwFormat.sampleRate
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRateRatio) + 1
            guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
                return
            }

            let consumedLock = NSLock()
            var consumed = false
            converter.convert(to: converted, error: nil) { _, outStatus in
                consumedLock.lock()
                defer { consumedLock.unlock() }
                if !consumed {
                    consumed = true
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
            let sampleSlice = UnsafeBufferPointer(start: channelData[0], count: frameCount)
            controller.enqueue(samples: Array(sampleSlice))
        }

        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            controller.stop(flush: false)
            throw ExecuTorchError.launchFailed("Audio engine start failed: \(error.localizedDescription)")
        }

        self.audioEngine = engine
        self.streamingController = controller
        self.state = .listening
        logger.info("ExecuTorch STT listening (embedded runtime)")
    }

    func stopListening() {
        self.audioEngine?.inputNode.removeTap(onBus: 0)
        self.audioEngine?.stop()
        self.audioEngine = nil

        self.streamingController?.stop(flush: true)
        self.streamingController = nil
        self.onTranscript = nil

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
        self.audioEngine?.inputNode.removeTap(onBus: 0)
        self.audioEngine?.stop()
        self.audioEngine = nil
        self.streamingController?.stop(flush: false)
        self.streamingController = nil
        self.onTranscript = nil
        self.setError(message)
    }

    private func handleToken(_ token: String) {
        self.transcriptBuffer += token
        self.onTranscript?(token, false)
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
}

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
