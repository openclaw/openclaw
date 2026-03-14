import Darwin
import Foundation
import OSLog

private let vxrtStatusOK: Int32 = 0
private let vxrtBackendMetal: Int32 = 2

typealias VxrtRunnerRef = UnsafeMutableRawPointer
typealias VxrtSessionRef = UnsafeMutableRawPointer

private struct VxrtRunnerConfig {
    var model_path: UnsafePointer<CChar>?
    var tokenizer_path: UnsafePointer<CChar>?
    var preprocessor_path: UnsafePointer<CChar>?
    var data_path: UnsafePointer<CChar>?
    var backend: Int32
    var warmup: Int32
}

private struct VxrtTranscribeConfig {
    var max_new_tokens: Int32
    var temperature: Float
}

private typealias VxrtTokenCallback = @convention(c) (
    _ piece: UnsafePointer<CChar>?,
    _ userData: UnsafeMutableRawPointer?
) -> Void
private typealias VxrtRunnerCreateFn = @convention(c) (
    _ config: UnsafeRawPointer?,
    _ outRunner: UnsafeMutablePointer<VxrtRunnerRef?>?
) -> Int32
private typealias VxrtRunnerDestroyFn = @convention(c) (_ runner: VxrtRunnerRef?) -> Void
private typealias VxrtRunnerTranscribeFn = @convention(c) (
    _ runner: VxrtRunnerRef?,
    _ audioData: UnsafePointer<Float>?,
    _ numSamples: Int64,
    _ config: UnsafeRawPointer?,
    _ callback: VxrtTokenCallback?,
    _ userData: UnsafeMutableRawPointer?,
    _ outNumGeneratedTokens: UnsafeMutablePointer<Int32>?
) -> Int32
private typealias VxrtRunnerCreateStreamingSessionFn = @convention(c) (
    _ runner: VxrtRunnerRef?,
    _ config: UnsafeRawPointer?,
    _ callback: VxrtTokenCallback?,
    _ userData: UnsafeMutableRawPointer?,
    _ outSession: UnsafeMutablePointer<VxrtSessionRef?>?
) -> Int32
private typealias VxrtSessionFeedAudioFn = @convention(c) (
    _ session: VxrtSessionRef?,
    _ data: UnsafePointer<Float>?,
    _ numSamples: Int64,
    _ outNewTokens: UnsafeMutablePointer<Int32>?
) -> Int32
private typealias VxrtSessionFlushFn = @convention(c) (
    _ session: VxrtSessionRef?,
    _ outTotalTokens: UnsafeMutablePointer<Int32>?
) -> Int32
private typealias VxrtSessionDestroyFn = @convention(c) (_ session: VxrtSessionRef?) -> Void
private typealias VxrtLastErrorFn = @convention(c) () -> UnsafePointer<CChar>?

private final class VxrtTokenSink: @unchecked Sendable {
    private let onToken: @Sendable (String) -> Void

    init(onToken: @escaping @Sendable (String) -> Void) {
        self.onToken = onToken
    }

    func emit(_ piece: String) {
        self.onToken(piece)
    }
}

private final class VxrtTokenCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var parts: [String] = []

    func append(_ piece: String) {
        lock.lock()
        defer { lock.unlock() }
        parts.append(piece)
    }

    func joined() -> String {
        lock.lock()
        defer { lock.unlock() }
        return parts.joined()
    }
}

private let ffiLog = Logger(subsystem: "ai.openclaw", category: "executorch.ffi")
/// When set, per-token callback and feed logs are emitted (expensive). Set OPENCLAW_EXECUTORCH_DEBUG=1 for debugging.
private let ffiVerboseLogging = ProcessInfo.processInfo.environment["OPENCLAW_EXECUTORCH_DEBUG"] == "1"

private func vxrtSwiftTokenCallback(
    _ piece: UnsafePointer<CChar>?,
    _ userData: UnsafeMutableRawPointer?
) {
    guard
        let piece,
        let userData
    else {
        if ffiVerboseLogging { ffiLog.warning("executorch.ffi: token callback with nil piece or userData") }
        return
    }
    let text = String(cString: piece)
    if ffiVerboseLogging {
        ffiLog.info("executorch.ffi: token callback raw len=\(text.count) text=\"\(text.prefix(60), privacy: .public)\"")
    }
    let sink = Unmanaged<VxrtTokenSink>.fromOpaque(userData).takeUnretainedValue()
    sink.emit(text)
}

final class VxrtRuntimeHandle: @unchecked Sendable {
    private let library: UnsafeMutableRawPointer
    private let runnerCreateFn: VxrtRunnerCreateFn
    private let runnerDestroyFn: VxrtRunnerDestroyFn
    private let runnerTranscribeFn: VxrtRunnerTranscribeFn
    private let runnerCreateStreamingSessionFn: VxrtRunnerCreateStreamingSessionFn
    private let sessionFeedAudioFn: VxrtSessionFeedAudioFn
    private let sessionFlushFn: VxrtSessionFlushFn
    private let sessionDestroyFn: VxrtSessionDestroyFn
    private let lastErrorFn: VxrtLastErrorFn

    private init(
        library: UnsafeMutableRawPointer,
        runnerCreateFn: VxrtRunnerCreateFn,
        runnerDestroyFn: VxrtRunnerDestroyFn,
        runnerTranscribeFn: VxrtRunnerTranscribeFn,
        runnerCreateStreamingSessionFn: VxrtRunnerCreateStreamingSessionFn,
        sessionFeedAudioFn: VxrtSessionFeedAudioFn,
        sessionFlushFn: VxrtSessionFlushFn,
        sessionDestroyFn: VxrtSessionDestroyFn,
        lastErrorFn: VxrtLastErrorFn
    ) {
        self.library = library
        self.runnerCreateFn = runnerCreateFn
        self.runnerDestroyFn = runnerDestroyFn
        self.runnerTranscribeFn = runnerTranscribeFn
        self.runnerCreateStreamingSessionFn = runnerCreateStreamingSessionFn
        self.sessionFeedAudioFn = sessionFeedAudioFn
        self.sessionFlushFn = sessionFlushFn
        self.sessionDestroyFn = sessionDestroyFn
        self.lastErrorFn = lastErrorFn
    }

    deinit {
        dlclose(self.library)
    }

    static func load(libraryPath: String) throws -> VxrtRuntimeHandle {
        guard let lib = dlopen(libraryPath, RTLD_NOW | RTLD_GLOBAL) else {
            let dlError = dlerror().flatMap { String(validatingUTF8: $0) } ?? "unknown dlopen error"
            throw ExecuTorchError.launchFailed("Failed to load runtime library (\(libraryPath)): \(dlError)")
        }

        do {
            let runnerCreate = try self.loadSymbol(lib, name: "vxrt_runner_create", as: VxrtRunnerCreateFn.self)
            let runnerDestroy = try self.loadSymbol(lib, name: "vxrt_runner_destroy", as: VxrtRunnerDestroyFn.self)
            let runnerTranscribe = try self.loadSymbol(
                lib,
                name: "vxrt_runner_transcribe",
                as: VxrtRunnerTranscribeFn.self)
            let createStreamingSession = try self.loadSymbol(
                lib,
                name: "vxrt_runner_create_streaming_session",
                as: VxrtRunnerCreateStreamingSessionFn.self)
            let sessionFeedAudio = try self.loadSymbol(
                lib,
                name: "vxrt_session_feed_audio",
                as: VxrtSessionFeedAudioFn.self)
            let sessionFlush = try self.loadSymbol(lib, name: "vxrt_session_flush", as: VxrtSessionFlushFn.self)
            let sessionDestroy = try self.loadSymbol(lib, name: "vxrt_session_destroy", as: VxrtSessionDestroyFn.self)
            let lastError = try self.loadSymbol(lib, name: "vxrt_last_error", as: VxrtLastErrorFn.self)
            return VxrtRuntimeHandle(
                library: lib,
                runnerCreateFn: runnerCreate,
                runnerDestroyFn: runnerDestroy,
                runnerTranscribeFn: runnerTranscribe,
                runnerCreateStreamingSessionFn: createStreamingSession,
                sessionFeedAudioFn: sessionFeedAudio,
                sessionFlushFn: sessionFlush,
                sessionDestroyFn: sessionDestroy,
                lastErrorFn: lastError)
        } catch {
            dlclose(lib)
            throw error
        }
    }

    private static func loadSymbol<T>(
        _ library: UnsafeMutableRawPointer,
        name: String,
        as _: T.Type
    ) throws -> T {
        _ = dlerror()
        guard let symbol = dlsym(library, name) else {
            let dlError = dlerror().flatMap { String(validatingUTF8: $0) } ?? "unknown dlsym error"
            throw ExecuTorchError.launchFailed("Missing runtime symbol \(name): \(dlError)")
        }
        return unsafeBitCast(symbol, to: T.self)
    }

    func lastErrorDescription(fallback: String) -> String {
        guard let ptr = self.lastErrorFn() else { return fallback }
        let text = String(cString: ptr).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? fallback : text
    }

    func createRunner(
        modelPath: String,
        tokenizerPath: String,
        preprocessorPath: String,
        warmup: Bool
    ) throws -> VxrtRunnerRef {
        var runner: VxrtRunnerRef?
        // C vxrt_runner_config_t: 4× const char* + vxrt_backend_t + int warmup (40 bytes on 64-bit).
        let status = modelPath.withCString { modelC in
            tokenizerPath.withCString { tokenizerC in
                preprocessorPath.withCString { preprocessorC in
                    var config = VxrtRunnerConfig(
                        model_path: modelC,
                        tokenizer_path: tokenizerC,
                        preprocessor_path: preprocessorC,
                        data_path: nil,
                        backend: vxrtBackendMetal,
                        warmup: warmup ? 1 : 0)
                    return withUnsafePointer(to: &config) { ptr in
                        self.runnerCreateFn(UnsafeRawPointer(ptr), &runner)
                    }
                }
            }
        }
        guard status == vxrtStatusOK, let runner else {
            let error = self.lastErrorDescription(fallback: "vxrt_runner_create failed")
            throw ExecuTorchError.launchFailed(error)
        }
        return runner
    }

    func destroyRunner(_ runner: VxrtRunnerRef?) {
        self.runnerDestroyFn(runner)
    }

    func transcribe(
        runner: VxrtRunnerRef,
        samples: [Float],
        maxNewTokens: Int32 = 160
    ) throws -> String {
        guard !samples.isEmpty else { return "" }
        var generatedTokens: Int32 = 0
        let collector = VxrtTokenCollector()
        let sink = VxrtTokenSink { piece in
            collector.append(piece)
        }
        let userData = UnsafeMutableRawPointer(Unmanaged.passRetained(sink).toOpaque())
        defer { Unmanaged<VxrtTokenSink>.fromOpaque(userData).release() }
        var config = VxrtTranscribeConfig(max_new_tokens: maxNewTokens, temperature: 0)
        let status = samples.withUnsafeBufferPointer { buffer in
            withUnsafePointer(to: &config) { ptr in
                self.runnerTranscribeFn(
                    runner,
                    buffer.baseAddress,
                    Int64(buffer.count),
                    UnsafeRawPointer(ptr),
                    vxrtSwiftTokenCallback,
                    userData,
                    &generatedTokens)
            }
        }
        guard status == vxrtStatusOK else {
            let error = self.lastErrorDescription(fallback: "vxrt_runner_transcribe failed")
            throw ExecuTorchError.launchFailed(error)
        }
        return collector.joined()
    }

    func createStreamingController(
        runner: VxrtRunnerRef,
        onToken: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) throws -> VxrtStreamingController {
        var session: VxrtSessionRef?
        var config = VxrtTranscribeConfig(max_new_tokens: 500, temperature: 0)
        let sink = VxrtTokenSink(onToken: onToken)
        let userData = UnsafeMutableRawPointer(Unmanaged.passRetained(sink).toOpaque())
        let status = withUnsafePointer(to: &config) { ptr in
            self.runnerCreateStreamingSessionFn(
                runner,
                UnsafeRawPointer(ptr),
                vxrtSwiftTokenCallback,
                userData,
                &session)
        }
        guard status == vxrtStatusOK, let session else {
            Unmanaged<VxrtTokenSink>.fromOpaque(userData).release()
            let error = self.lastErrorDescription(fallback: "vxrt_runner_create_streaming_session failed")
            throw ExecuTorchError.launchFailed(error)
        }
        return VxrtStreamingController(
            runtime: self,
            session: session,
            tokenUserData: userData,
            onError: onError)
    }

    fileprivate func sessionFeedAudio(
        _ session: VxrtSessionRef?,
        _ data: UnsafePointer<Float>?,
        _ numSamples: Int64,
        _ outNewTokens: UnsafeMutablePointer<Int32>?
    ) -> Int32 {
        self.sessionFeedAudioFn(session, data, numSamples, outNewTokens)
    }

    fileprivate func sessionFlush(
        _ session: VxrtSessionRef?,
        _ outTotalTokens: UnsafeMutablePointer<Int32>?
    ) -> Int32 {
        self.sessionFlushFn(session, outTotalTokens)
    }

    fileprivate func sessionDestroy(_ session: VxrtSessionRef?) {
        self.sessionDestroyFn(session)
    }
}

final class VxrtStreamingController: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "executorch.ffi")
    private let runtime: VxrtRuntimeHandle
    private let onError: @Sendable (String) -> Void
    private let lock = NSLock()
    private var session: VxrtSessionRef?
    private var tokenUserData: UnsafeMutableRawPointer?
    private let feedQueue = DispatchQueue(label: "ai.openclaw.executorch.streaming-feed")
    /// Tracks whether we've fed at least one chunk; flush is only safe after feed (avoids EXC_BAD_ACCESS in some runtimes).
    private var hasFedAtLeastOnce = false
    private var feedCount = 0

    init(
        runtime: VxrtRuntimeHandle,
        session: VxrtSessionRef,
        tokenUserData: UnsafeMutableRawPointer,
        onError: @escaping @Sendable (String) -> Void
    ) {
        self.runtime = runtime
        self.session = session
        self.tokenUserData = tokenUserData
        self.onError = onError
    }

    deinit {
        self.stop(flush: false)
    }

    func enqueue(samples: [Float]) {
        guard !samples.isEmpty else { return }
        self.feedQueue.async { [self, samples] in
            guard let session = self.currentSession() else { return }
            var newTokens: Int32 = 0
            let t0 = CFAbsoluteTimeGetCurrent()
            let status = samples.withUnsafeBufferPointer { buffer in
                self.runtime.sessionFeedAudio(session, buffer.baseAddress, Int64(buffer.count), &newTokens)
            }
            let elapsed = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            self.markFedIfNeeded()
            self.feedCount += 1
            if ffiVerboseLogging, (self.feedCount <= 5 || self.feedCount % 50 == 0 || newTokens > 0) {
                self.logger.info(
                    "executorch.ffi: feed #\(self.feedCount) samples=\(samples.count) status=\(status) newTokens=\(newTokens) elapsed=\(String(format: "%.1f", elapsed))ms")
            }
            guard status == vxrtStatusOK else {
                self.onError(self.runtime.lastErrorDescription(fallback: "Failed to feed streaming audio"))
                return
            }
        }
    }

    func stop(flush: Bool) {
        let snapshot = self.detachSession()
        guard let session = snapshot.session else {
            if let userData = snapshot.userData {
                Unmanaged<VxrtTokenSink>.fromOpaque(userData).release()
            }
            return
        }
        let shouldFlush = flush && snapshot.hasFedAtLeastOnce
        self.feedQueue.sync {
            if shouldFlush {
                var totalTokens: Int32 = 0
                let status = self.runtime.sessionFlush(session, &totalTokens)
                if status != vxrtStatusOK {
                    self.onError(self.runtime.lastErrorDescription(fallback: "Failed to flush streaming session"))
                }
            }
            self.runtime.sessionDestroy(session)
        }
        if let userData = snapshot.userData {
            Unmanaged<VxrtTokenSink>.fromOpaque(userData).release()
        }
    }

    private func markFedIfNeeded() {
        self.lock.lock()
        defer { self.lock.unlock() }
        if !hasFedAtLeastOnce { hasFedAtLeastOnce = true }
    }

    private func currentSession() -> VxrtSessionRef? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.session
    }

    private func detachSession() -> (
        session: VxrtSessionRef?,
        userData: UnsafeMutableRawPointer?,
        hasFedAtLeastOnce: Bool
    ) {
        self.lock.lock()
        defer { self.lock.unlock() }
        let snapshot = (self.session, self.tokenUserData, self.hasFedAtLeastOnce)
        self.session = nil
        self.tokenUserData = nil
        return snapshot
    }
}
