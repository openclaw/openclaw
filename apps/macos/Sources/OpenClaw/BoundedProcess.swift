import Darwin
import Foundation
import Subprocess

enum BoundedProcessError: Error {
    case timedOut
}

struct BoundedProcessResult: Sendable {
    var output: Data
    var terminationStatus: Int32
}

enum BoundedProcess {
    private static let outputLimit = 64 * 1024

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        standardError: some ErrorOutputProtocol = .combinedWithOutput,
        whileRunning: @escaping @Sendable (ChildProcessExit) async throws -> Void = { _ in },
        timeout: TimeInterval) async throws -> BoundedProcessResult
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
            environment: environment.map(self.environment(from:)) ?? .inherit,
            workingDirectory: workingDirectory.map { .init($0) },
            platformOptions: platformOptions)
        let executionResult = try await Subprocess.run(
            configuration,
            input: .none,
            output: .bytes(limit: self.outputLimit),
            error: standardError)
        { execution in
            let exitSignal = ChildProcessExit(
                processIdentifier: pid_t(execution.processIdentifier.value))
            let timedOut = try await withThrowingTaskGroup(of: Bool?.self) { group in
                group.addTask {
                    let deadline = await exitSignal.wait(timeout: timeout)
                    try Task.checkCancellation()
                    // Terminate before joining the observer: its callback may be awaiting a busy UI actor.
                    switch deadline {
                    case .exited:
                        // The body still owns the unreaped leader, so its process-group ID cannot be reused.
                        try? execution.send(signal: .kill, toProcessGroup: true)
                        return false
                    case .timedOut:
                        if exitSignal.hasExited() {
                            try? execution.send(signal: .kill, toProcessGroup: true)
                            return false
                        }
                        try? execution.send(signal: .terminate, toProcessGroup: true)
                        try? await Task.sleep(for: .milliseconds(100))
                        try? execution.send(signal: .kill, toProcessGroup: true)
                        return true
                    }
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
        let data = Data(executionResult.standardOutput)
        let terminationStatus = switch executionResult.terminationStatus {
        case let .exited(code), let .signaled(code):
            Int32(code)
        }
        return BoundedProcessResult(output: data, terminationStatus: terminationStatus)
    }

    private static func environment(from values: [String: String]) -> Environment {
        var converted: [Environment.Key: String] = [:]
        converted.reserveCapacity(values.count)
        for (key, value) in values {
            guard let environmentKey = Environment.Key(rawValue: key) else { continue }
            converted[environmentKey] = value
        }
        return .custom(converted)
    }
}
