import Foundation
import OpenClawIPC

enum ShellExecutor {
    private final class DataBox: @unchecked Sendable {
        var value = Data()
    }

    struct ShellResult {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = command
                if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
                if let env { process.environment = env }

                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                process.standardOutput = stdoutPipe
                process.standardError = stderrPipe

                let processGroup = DispatchGroup()
                processGroup.enter()
                process.terminationHandler = { _ in
                    processGroup.leave()
                }

                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: ShellResult(
                        stdout: "",
                        stderr: "",
                        exitCode: nil,
                        timedOut: false,
                        success: false,
                        errorMessage: "failed to start: \(error.localizedDescription)"))
                    return
                }

                let stdoutBox = DataBox()
                let stderrBox = DataBox()
                let ioGroup = DispatchGroup()

                ioGroup.enter()
                DispatchQueue.global(qos: .utility).async {
                    stdoutBox.value = stdoutPipe.fileHandleForReading.readToEndSafely()
                    ioGroup.leave()
                }

                ioGroup.enter()
                DispatchQueue.global(qos: .utility).async {
                    stderrBox.value = stderrPipe.fileHandleForReading.readToEndSafely()
                    ioGroup.leave()
                }

                let timedOut: Bool
                if let timeout, timeout > 0 {
                    timedOut = processGroup.wait(timeout: .now() + timeout) == .timedOut
                } else {
                    processGroup.wait()
                    timedOut = false
                }

                if timedOut, process.isRunning {
                    process.terminate()
                    processGroup.wait()
                }

                ioGroup.wait()

                let status = Int(process.terminationStatus)
                continuation.resume(returning: ShellResult(
                    stdout: String(bytes: stdoutBox.value, encoding: .utf8) ?? "",
                    stderr: String(bytes: stderrBox.value, encoding: .utf8) ?? "",
                    exitCode: timedOut ? nil : status,
                    timedOut: timedOut,
                    success: !timedOut && status == 0,
                    errorMessage: timedOut ? "timeout" : (status == 0 ? nil : "exit \(status)")))
            }
        }
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
