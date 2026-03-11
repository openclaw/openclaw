@preconcurrency import AVFoundation
import Accelerate
import Foundation
import OSLog

/// Thread-safe holder so a single continuation can be resumed once from any thread (Sendable-safe).
private final class ContinuationHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private let continuation: CheckedContinuation<Void, Error>
    init(_ c: CheckedContinuation<Void, Error>) { continuation = c }
    func resume() {
        lock.lock()
        defer { lock.unlock() }
        if !resumed { resumed = true; continuation.resume() }
    }
    func resume(throwing e: Error) {
        lock.lock()
        defer { lock.unlock() }
        if !resumed { resumed = true; continuation.resume(throwing: e) }
    }
}

/// Thread-safe “finish once” state so DispatchQueue closures can call finish/didFinish in a Sendable-safe way.
private final class FinishState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    func finish(_ action: @Sendable () -> Void) {
        lock.lock()
        if finished { lock.unlock(); return }
        finished = true
        lock.unlock()
        action()
    }
    func didFinish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return finished
    }
}

/// Swift actor that bridges to the ExecuTorch `voxtral_realtime_runner` binary
/// for on-device speech-to-text. Adapted from VoxtralRealtimeApp's RunnerBridge
/// and AudioEngine pattern.
///
/// Audio pipeline: Mic → AVAudioEngine → 16 kHz mono f32le → runner stdin → transcript tokens on stdout
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

    private var process: Process?
    private var stdinPipe: Pipe?
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

    private var runnerPath: String {
        if let bundled = Bundle.main.resourcePath {
            let bundledRunner = "\(bundled)/voxtral_realtime_runner"
            if FileManager.default.fileExists(atPath: bundledRunner) {
                return bundledRunner
            }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.openclaw/bin/voxtral_realtime_runner"
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
            ("Runner", runnerPath),
            ("Model", modelPath),
            ("Tokenizer", tokenizerPath),
            ("Preprocessor", preprocessorPath),
        ]
        for (label, path) in paths {
            if !FileManager.default.fileExists(atPath: path) {
                missing.append("\(label): \(path)")
            }
        }
        return (missing.isEmpty, missing)
    }

    // MARK: - Runner Lifecycle

    /// Launch the runner and wait for the model to load (~30s first time).
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
        logger.info("Launching voxtral_realtime_runner...")

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdinPipe = Pipe()
        self.stdinPipe = stdinPipe

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runnerPath)
        proc.arguments = [
            "--model_path", modelPath,
            "--tokenizer_path", tokenizerPath,
            "--preprocessor_path", preprocessorPath,
            "--mic",
        ]

        var env = ProcessInfo.processInfo.environment
        if let resources = Bundle.main.resourcePath {
            let existing = env["DYLD_LIBRARY_PATH"] ?? ""
            env["DYLD_LIBRARY_PATH"] = existing.isEmpty ? resources : "\(resources):\(existing)"
        }
        proc.environment = env
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe
        self.process = proc

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ref = self
            let handle = stderrPipe.fileHandleForReading
            while true {
                let data = handle.availableData
                if data.isEmpty { break }
                if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .newlines), !text.isEmpty {
                    Task { await ref?.logStatus(text) }
                }
            }
        }

        proc.terminationHandler = { [weak self] process in
            let code = process.terminationStatus
            Task { await self?.handleTermination(code: code) }
        }

        do {
            try proc.run()
            logger.info("Runner started (pid: \(proc.processIdentifier))")
        } catch {
            state = .error(error.localizedDescription)
            throw ExecuTorchError.launchFailed(error.localizedDescription)
        }

        try await waitForModelReady(stdout: stdoutPipe)
    }

    private func waitForModelReady(stdout: Pipe) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let holder = ContinuationHolder(continuation)
            let state = FinishState()

            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let ref = self
                let handle = stdout.fileHandleForReading
                while true {
                    let data = handle.availableData
                    if data.isEmpty { break }

                    guard let text = String(data: data, encoding: .utf8) else { continue }

                    if text.contains("Listening") {
                        state.finish {
                            Task { await ref?.setReady() }
                            holder.resume()
                        }

                        let remainder = text
                            .replacingOccurrences(of: "Listening (Ctrl+C to stop)...", with: "")
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if !remainder.isEmpty {
                            Task { await ref?.handleToken(remainder) }
                        }
                        continue
                    }

                    if state.didFinish() {
                        let cleaned = Self.cleanRunnerOutput(text)
                        if !cleaned.isEmpty {
                            Task { await ref?.handleToken(cleaned) }
                        }
                    }
                }

                state.finish {
                    Task { await ref?.setError("Runner exited before model became ready") }
                    holder.resume(throwing: ExecuTorchError.launchFailed(
                        "Runner exited before model became ready"))
                }
            }

            DispatchQueue.global().asyncAfter(deadline: .now() + 120) { [weak self] in
                guard let ref = self else { return }
                state.finish {
                    Task { await ref.setError("Model load timed out") }
                    holder.resume(throwing: ExecuTorchError.modelLoadTimeout)
                }
            }
        }
    }

    // MARK: - Audio Capture

    /// Start capturing audio from the microphone and streaming to the runner.
    func startListening(onTranscript: @escaping (String, Bool) -> Void) throws {
        guard case .ready = state else {
            throw ExecuTorchError.notReady
        }
        guard let stdinPipe else {
            throw ExecuTorchError.notReady
        }

        self.onTranscript = onTranscript

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)

        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            throw ExecuTorchError.microphoneNotAvailable
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ) else {
            throw ExecuTorchError.audioConversionFailed
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            throw ExecuTorchError.audioConversionFailed
        }

        let sampleRateRatio = 16000.0 / hwFormat.sampleRate
        let handle = stdinPipe.fileHandleForWriting

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

            guard converted.frameLength > 0, let channelData = converted.floatChannelData else { return }

            let frameCount = Int(converted.frameLength)
            let samples = channelData[0]
            let byteCount = frameCount * MemoryLayout<Float>.size
            let data = Data(bytes: samples, count: byteCount)

            do {
                try handle.write(contentsOf: data)
            } catch {
                // Pipe may be broken if runner exited
            }
        }

        try engine.start()
        self.audioEngine = engine
        state = .listening
        logger.info("ExecuTorch STT listening")
    }

    /// Stop capturing audio but keep the runner alive.
    func stopListening() {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        onTranscript = nil
        if case .listening = state {
            state = .ready
        }
        logger.info("ExecuTorch STT stopped listening")
    }

    /// Full shutdown — stops audio and kills the runner process.
    func shutdown() {
        stopListening()

        stdinPipe?.fileHandleForWriting.closeFile()
        stdinPipe = nil

        if let proc = process, proc.isRunning {
            proc.interrupt()
            proc.waitUntilExit()
        }
        process = nil
        state = .idle
        transcriptBuffer = ""
        logger.info("ExecuTorch STT shutdown")
    }

    // MARK: - Private

    private func setReady() {
        state = .ready
        logger.info("ExecuTorch model loaded — ready")
    }

    private func setError(_ message: String) {
        state = .error(message)
        logger.error("ExecuTorch error: \(message, privacy: .public)")
    }

    private func logStatus(_ text: String) {
        logger.info("ExecuTorch: \(text, privacy: .public)")
    }

    private func handleTermination(code: Int32) {
        stdinPipe = nil
        process = nil
        if case .loading = state {
            state = .error("Runner exited during model load (code \(code))")
            logger.error("ExecuTorch runner exited during model load (code: \(code))")
        } else if case .listening = state {
            state = .idle
        } else if case .ready = state {
            state = .idle
        }
        logger.info("ExecuTorch runner exited (code: \(code))")
    }

    private func handleToken(_ token: String) {
        transcriptBuffer += token
        onTranscript?(token, false)
    }

    func getAndClearTranscript() -> String {
        let result = transcriptBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptBuffer = ""
        return result
    }

    private static func cleanRunnerOutput(_ text: String) -> String {
        var cleaned = text
        // Strip PyTorchObserver stats
        if cleaned.contains("PyTorchObserver") {
            cleaned = cleaned
                .components(separatedBy: "\n")
                .filter { !$0.contains("PyTorchObserver") }
                .joined(separator: "\n")
        }
        // Strip ANSI escape codes
        cleaned = cleaned.replacingOccurrences(
            of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
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
    case modelLoadTimeout
    case notReady
    case alreadyRunning
    case microphoneNotAvailable
    case audioConversionFailed

    var errorDescription: String? {
        switch self {
        case .filesNotFound(let detail): return "ExecuTorch files not found: \(detail)"
        case .launchFailed(let detail): return "Failed to launch runner: \(detail)"
        case .modelLoadTimeout: return "Model load timed out (>120s)"
        case .notReady: return "Runner not ready"
        case .alreadyRunning: return "Runner already running"
        case .microphoneNotAvailable: return "No microphone available"
        case .audioConversionFailed: return "Audio format conversion failed"
        }
    }
}
