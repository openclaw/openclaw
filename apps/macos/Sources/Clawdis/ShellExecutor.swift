import ClawdisIPC
import Foundation

enum ShellExecutor {
    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        guard !command.isEmpty else { return Response(ok: false, message: "empty command") }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { process.environment = env }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return Response(ok: false, message: "failed to start: \(error.localizedDescription)")
        }

        let waitTask = Task { () -> Response in
            process.waitUntilExit()
            let out = stdoutPipe.fileHandleForReading.readToEndSafely()
            let err = stderrPipe.fileHandleForReading.readToEndSafely()
            let status = process.terminationStatus
            let combined = out.isEmpty ? err : out
            return Response(ok: status == 0, message: status == 0 ? nil : "exit \(status)", payload: combined)
        }

        if let timeout, timeout > 0 {
            let nanos = UInt64(timeout * 1_000_000_000)
            let response = await withTaskGroup(of: Response.self) { group in
                group.addTask { await waitTask.value }
                group.addTask {
                    try? await Task.sleep(nanoseconds: nanos)
                    if process.isRunning { process.terminate() }
                    _ = await waitTask.value // drain pipes after termination
                    return Response(ok: false, message: "timeout")
                }
                // Whichever completes first (process exit or timeout) wins; cancel the other branch.
                let first = await group.next()!
                group.cancelAll()
                return first
            }
            return response
        }

        return await waitTask.value
    }
}
