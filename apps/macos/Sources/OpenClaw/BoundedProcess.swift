import Darwin
import Foundation
import Subprocess

enum BoundedProcessError: Error {
    case timedOut
}

struct BoundedProcessResult: Sendable {
    var output: Data
    var terminationStatus: Int32
    var errorOutput = Data()
}

enum BoundedProcess {
    private static let outputLimit = 64 * 1024

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        input: Data? = nil,
        outputLimit: Int = Self.outputLimit,
        standardError: some ErrorOutputProtocol = .combinedWithOutput,
        whileRunning: @escaping @Sendable (ChildProcessExit) async throws -> Void = { _ in },
        timeout: TimeInterval) async throws -> BoundedProcessResult
    {
        let result = if let input {
            try await self.execute(
                path: path,
                arguments: arguments,
                environment: environment,
                workingDirectory: workingDirectory,
                input: .array(Array(input)),
                outputLimit: outputLimit,
                standardError: standardError,
                whileRunning: whileRunning,
                timeout: timeout)
        } else {
            try await self.execute(
                path: path,
                arguments: arguments,
                environment: environment,
                workingDirectory: workingDirectory,
                input: .none,
                outputLimit: outputLimit,
                standardError: standardError,
                whileRunning: whileRunning,
                timeout: timeout)
        }
        return self.result(result)
    }

    static func runCapturingError(
        path: String,
        arguments: [String],
        environment: [String: String],
        input: Data,
        outputLimit: Int,
        timeout: TimeInterval) async throws -> BoundedProcessResult
    {
        let result = try await self.execute(
            path: path,
            arguments: arguments,
            environment: environment,
            input: .array(Array(input)),
            outputLimit: outputLimit,
            standardError: .bytes(limit: 64 * 1024),
            timeout: timeout)
        var captured = self.result(result)
        captured.errorOutput = Data(result.standardError)
        return captured
    }

    private static func execute<StandardError: ErrorOutputProtocol>(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        input: some InputProtocol,
        outputLimit: Int = Self.outputLimit,
        standardError: StandardError,
        whileRunning: @escaping @Sendable (ChildProcessExit) async throws -> Void = { _ in },
        timeout: TimeInterval) async throws -> ExecutionResult<Bool, BytesOutput, StandardError>
    {
        precondition(timeout > 0)
        var platformOptions = PlatformOptions()
        platformOptions.qualityOfService = .utility
        platformOptions.createSession = true
        platformOptions.teardownSequence = [
            .send(
                signal: .kill,
                toProcessGroup: true,
                allowedDurationToNextStep: .zero),
        ]
        let configuration = Configuration(
            executable: .path(.init(path)),
            arguments: Arguments(arguments),
            environment: environment.map(ManagedProcess.environment(from:)) ?? .inherit,
            workingDirectory: workingDirectory.map { .init($0) },
            platformOptions: platformOptions)
        let executionResult = try await Subprocess.run(
            configuration,
            input: input,
            output: .bytes(limit: outputLimit),
            error: standardError)
        { execution in
            let exitSignal = ChildProcessExit(
                processIdentifier: pid_t(execution.processIdentifier.value))
            let timedOut = try await withThrowingTaskGroup(of: Bool?.self) { group in
                group.addTask {
                    let deadline = await exitSignal.wait(timeout: timeout)
                    try Task.checkCancellation()
                    // Terminate before joining the observer: its callback may be awaiting a busy UI actor.
                    let timedOut = deadline == .timedOut && !exitSignal.hasExited()
                    if timedOut {
                        try? execution.send(signal: .terminate, toProcessGroup: true)
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                    // The body still owns the unreaped leader, so its process-group ID cannot be reused.
                    try? execution.send(signal: .kill, toProcessGroup: true)
                    return timedOut
                }
                group.addTask {
                    try await whileRunning(exitSignal)
                    return nil
                }
                defer { group.cancelAll() }
                for try await outcome in group {
                    if let outcome { return outcome }
                }
                throw CancellationError()
            }
            try Task.checkCancellation()
            return timedOut
        }

        if executionResult.closureResult {
            throw BoundedProcessError.timedOut
        }
        return executionResult
    }

    private static func result(
        _ executionResult: ExecutionResult<Bool, BytesOutput, some ErrorOutputProtocol>) -> BoundedProcessResult
    {
        let data = Data(executionResult.standardOutput)
        let terminationStatus = switch executionResult.terminationStatus {
        case let .exited(code), let .signaled(code):
            Int32(code)
        }
        return BoundedProcessResult(output: data, terminationStatus: terminationStatus)
    }
}
