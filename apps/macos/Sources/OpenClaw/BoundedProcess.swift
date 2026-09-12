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

    private enum DeadlineOutcome: Sendable {
        case exited
        case timedOut
    }

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        standardError: some ErrorOutputProtocol = .combinedWithOutput,
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
            let deadline = await withTaskGroup(of: DeadlineOutcome.self) { group in
                group.addTask {
                    await exitSignal.wait()
                    return .exited
                }
                group.addTask {
                    do {
                        try await Task.sleep(for: .seconds(timeout))
                        return .timedOut
                    } catch {
                        return .exited
                    }
                }
                defer { group.cancelAll() }
                return await group.next() ?? .exited
            }
            try Task.checkCancellation()

            switch deadline {
            case .exited:
                // The body runs before swift-subprocess reaps the group leader.
                // Kill inherited descendants while the pid cannot be recycled.
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
