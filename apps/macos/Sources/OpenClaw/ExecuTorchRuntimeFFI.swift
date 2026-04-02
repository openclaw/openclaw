import Darwin
import Foundation
import OSLog

private let pqtStatusOK: Int32 = 0
private let pqtBackendMetal: Int32 = 2

typealias PqtRunnerRef = UnsafeMutableRawPointer

private struct PqtRunnerConfig {
    var model_path: UnsafePointer<CChar>?
    var tokenizer_path: UnsafePointer<CChar>?
    var data_path: UnsafePointer<CChar>?
    var backend: Int32
    var warmup: Int32
}

private struct PqtTranscribeConfig {
    var max_new_tokens: Int32
    var temperature: Float
}

private typealias PqtTokenCallback = @convention(c) (
    _ piece: UnsafePointer<CChar>?,
    _ userData: UnsafeMutableRawPointer?) -> Void
private typealias PqtRunnerCreateFn = @convention(c) (
    _ config: UnsafeRawPointer?,
    _ outRunner: UnsafeMutablePointer<PqtRunnerRef?>?) -> Int32
private typealias PqtRunnerDestroyFn = @convention(c) (_ runner: PqtRunnerRef?) -> Void
private typealias PqtRunnerTranscribeFn = @convention(c) (
    _ runner: PqtRunnerRef?,
    _ audioData: UnsafePointer<Float>?,
    _ numSamples: Int64,
    _ config: UnsafeRawPointer?,
    _ callback: PqtTokenCallback?,
    _ userData: UnsafeMutableRawPointer?,
    _ outNumGeneratedTokens: UnsafeMutablePointer<Int32>?) -> Int32
private typealias PqtLastErrorFn = @convention(c) () -> UnsafePointer<CChar>?

private final class PqtTokenSink: @unchecked Sendable {
    private let onToken: @Sendable (String) -> Void

    init(onToken: @escaping @Sendable (String) -> Void) {
        self.onToken = onToken
    }

    func emit(_ piece: String) {
        self.onToken(piece)
    }
}

private final class PqtTokenCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var parts: [String] = []

    func append(_ piece: String) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.parts.append(piece)
    }

    func joined() -> String {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.parts.joined()
    }
}

private let ffiLog = Logger(subsystem: "ai.openclaw", category: "executorch.ffi")
private let ffiVerboseLogging = ProcessInfo.processInfo.environment["OPENCLAW_EXECUTORCH_DEBUG"] == "1"

private func pqtSwiftTokenCallback(
    _ piece: UnsafePointer<CChar>?,
    _ userData: UnsafeMutableRawPointer?)
{
    guard let piece, let userData else {
        if ffiVerboseLogging {
            ffiLog.warning("executorch.ffi: token callback with nil piece or userData")
        }
        return
    }
    let text = String(cString: piece)
    if ffiVerboseLogging {
        ffiLog.info(
            "executorch.ffi: token callback raw len=\(text.count) text=\"\(text.prefix(60), privacy: .public)\"")
    }
    let sink = Unmanaged<PqtTokenSink>.fromOpaque(userData).takeUnretainedValue()
    sink.emit(text)
}

final class PqtRuntimeHandle: @unchecked Sendable {
    private let library: UnsafeMutableRawPointer
    private let runnerCreateFn: PqtRunnerCreateFn
    private let runnerDestroyFn: PqtRunnerDestroyFn
    private let runnerTranscribeFn: PqtRunnerTranscribeFn
    private let lastErrorFn: PqtLastErrorFn

    private init(
        library: UnsafeMutableRawPointer,
        runnerCreateFn: PqtRunnerCreateFn,
        runnerDestroyFn: PqtRunnerDestroyFn,
        runnerTranscribeFn: PqtRunnerTranscribeFn,
        lastErrorFn: PqtLastErrorFn)
    {
        self.library = library
        self.runnerCreateFn = runnerCreateFn
        self.runnerDestroyFn = runnerDestroyFn
        self.runnerTranscribeFn = runnerTranscribeFn
        self.lastErrorFn = lastErrorFn
    }

    deinit {
        dlclose(self.library)
    }

    static func load(libraryPath: String) throws -> PqtRuntimeHandle {
        guard let lib = dlopen(libraryPath, RTLD_NOW | RTLD_GLOBAL) else {
            let dlError = dlerror().flatMap { String(validatingUTF8: $0) } ?? "unknown dlopen error"
            throw ExecuTorchError.launchFailed("Failed to load runtime library (\(libraryPath)): \(dlError)")
        }

        do {
            let runnerCreate = try self.loadSymbol(lib, name: "pqt_runner_create", as: PqtRunnerCreateFn.self)
            let runnerDestroy = try self.loadSymbol(lib, name: "pqt_runner_destroy", as: PqtRunnerDestroyFn.self)
            let runnerTranscribe = try self.loadSymbol(
                lib,
                name: "pqt_runner_transcribe",
                as: PqtRunnerTranscribeFn.self)
            let lastError = try self.loadSymbol(lib, name: "pqt_last_error", as: PqtLastErrorFn.self)
            return PqtRuntimeHandle(
                library: lib,
                runnerCreateFn: runnerCreate,
                runnerDestroyFn: runnerDestroy,
                runnerTranscribeFn: runnerTranscribe,
                lastErrorFn: lastError)
        } catch {
            dlclose(lib)
            throw error
        }
    }

    private static func loadSymbol<T>(
        _ library: UnsafeMutableRawPointer,
        name: String,
        as _: T.Type) throws -> T
    {
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
        dataPath: String? = nil,
        warmup: Bool) throws -> PqtRunnerRef
    {
        var runner: PqtRunnerRef?

        let createStatus: Int32 = modelPath.withCString { modelC in
            tokenizerPath.withCString { tokenizerC in
                let buildConfigAndCall: (UnsafePointer<CChar>?) -> Int32 = { dataC in
                    var config = PqtRunnerConfig(
                        model_path: modelC,
                        tokenizer_path: tokenizerC,
                        data_path: dataC,
                        backend: pqtBackendMetal,
                        warmup: warmup ? 1 : 0)
                    return withUnsafePointer(to: &config) { ptr in
                        self.runnerCreateFn(UnsafeRawPointer(ptr), &runner)
                    }
                }

                if let dataPath, !dataPath.isEmpty {
                    return dataPath.withCString { dataC in
                        buildConfigAndCall(dataC)
                    }
                }
                return buildConfigAndCall(nil)
            }
        }

        guard createStatus == pqtStatusOK, let runner else {
            let error = self.lastErrorDescription(fallback: "pqt_runner_create failed")
            throw ExecuTorchError.launchFailed(error)
        }
        return runner
    }

    func destroyRunner(_ runner: PqtRunnerRef?) {
        self.runnerDestroyFn(runner)
    }

    func transcribe(
        runner: PqtRunnerRef,
        samples: [Float],
        maxNewTokens: Int32 = 160) throws -> String
    {
        guard !samples.isEmpty else { return "" }
        var generatedTokens: Int32 = 0
        let collector = PqtTokenCollector()
        let sink = PqtTokenSink { piece in
            collector.append(piece)
        }
        let userData = UnsafeMutableRawPointer(Unmanaged.passRetained(sink).toOpaque())
        defer { Unmanaged<PqtTokenSink>.fromOpaque(userData).release() }

        var config = PqtTranscribeConfig(max_new_tokens: maxNewTokens, temperature: 0)
        let status = samples.withUnsafeBufferPointer { buffer in
            withUnsafePointer(to: &config) { ptr in
                self.runnerTranscribeFn(
                    runner,
                    buffer.baseAddress,
                    Int64(buffer.count),
                    UnsafeRawPointer(ptr),
                    pqtSwiftTokenCallback,
                    userData,
                    &generatedTokens)
            }
        }
        guard status == pqtStatusOK else {
            let error = self.lastErrorDescription(fallback: "pqt_runner_transcribe failed")
            throw ExecuTorchError.launchFailed(error)
        }
        return collector.joined()
    }
}
