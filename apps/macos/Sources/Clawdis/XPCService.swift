import ClawdisIPC
import Foundation
import OSLog

@objc protocol ClawdisXPCProtocol {
    func handle(_ data: Data, withReply reply: @escaping @Sendable (Data?, Error?) -> Void)
}

final class ClawdisXPCService: NSObject, ClawdisXPCProtocol {
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "xpc")

    func handle(_ data: Data, withReply reply: @escaping @Sendable (Data?, Error?) -> Void) {
        let logger = logger
        Task.detached { @Sendable in
            do {
                let request = try JSONDecoder().decode(Request.self, from: data)
                let response = try await Self.process(request: request, notifier: NotificationManager(), logger: logger)
                let encoded = try JSONEncoder().encode(response)
                await MainActor.run { reply(encoded, nil) }
            } catch {
                logger.error("Failed to handle XPC request: \(error.localizedDescription, privacy: .public)")
                let resp = Response(ok: false, message: "decode/handle error: \(error.localizedDescription)")
                await MainActor.run { reply(try? JSONEncoder().encode(resp), error) }
            }
        }
    }

    private static func process(
        request: Request,
        notifier: NotificationManager,
        logger: Logger) async throws -> Response
    {
        let paused = await MainActor.run { AppStateStore.isPausedFlag }
        if paused {
            return Response(ok: false, message: "clawdis paused")
        }

        switch request {
        case let .notify(title, body, sound):
            let chosenSound = sound?.trimmingCharacters(in: .whitespacesAndNewlines)
            let ok = await notifier.send(title: title, body: body, sound: chosenSound)
            return ok ? Response(ok: true) : Response(ok: false, message: "notification not authorized")

        case let .ensurePermissions(caps, interactive):
            let statuses = await PermissionManager.ensure(caps, interactive: interactive)
            let missing = statuses.filter { !$0.value }.map(\.key.rawValue)
            let ok = missing.isEmpty
            let msg = ok ? "all granted" : "missing: \(missing.joined(separator: ","))"
            return Response(ok: ok, message: msg)

        case .status:
            return Response(ok: true, message: "ready")

        case .rpcStatus:
            let result = await AgentRPC.shared.status()
            return Response(ok: result.ok, message: result.error)

        case let .screenshot(displayID, windowID, _):
            let authorized = await PermissionManager
                .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
            guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
            if let data = await Screenshotter.capture(displayID: displayID, windowID: windowID) {
                return Response(ok: true, payload: data)
            }
            return Response(ok: false, message: "screenshot failed")

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            if needsSR {
                let authorized = await PermissionManager
                    .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
                guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
            }
            return await ShellExecutor.run(command: command, cwd: cwd, env: env, timeout: timeoutSec)

        case let .agent(message, thinking, session, deliver, to):
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return Response(ok: false, message: "message empty") }
            let sessionKey = session ?? "main"
            let rpcResult = await AgentRPC.shared.send(
                text: trimmed,
                thinking: thinking,
                session: sessionKey,
                deliver: deliver,
                to: to)
            return rpcResult.ok
                ? Response(ok: true, message: rpcResult.text ?? "sent")
                : Response(ok: false, message: rpcResult.error ?? "failed to send")
        }
    }

    private static func runAgentCLI(
        message: String,
        thinking: String?,
        session: String,
        deliver: Bool,
        to: String?) async -> (ok: Bool, text: String?, error: String?)
    {
        let projectRoot = CommandResolver.projectRootPath()
        var command = CommandResolver.clawdisCommand(subcommand: "agent")
        command += ["--message", message, "--json"]
        if let to { command += ["--to", to] }
        if deliver { command += ["--deliver"] }
        if !session.isEmpty { command += ["--session-id", session] }
        if let thinking { command += ["--thinking", thinking] }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.first ?? "/usr/bin/env")
        process.arguments = Array(command.dropFirst())
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        do {
            try process.run()
        } catch {
            return (false, nil, "launch failed: \(error.localizedDescription)")
        }

        process.waitUntilExit()
        let outputData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errPipe.fileHandleForReading.readDataToEndOfFile()

        guard process.terminationStatus == 0 else {
            let errStr = String(data: errorData, encoding: .utf8) ?? "agent failed"
            return (false, nil, errStr.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        if
            let obj = try? JSONSerialization.jsonObject(with: outputData) as? [String: Any],
            let payloads = obj["payloads"] as? [[String: Any]],
            let first = payloads.first,
            let text = first["text"] as? String
        {
            return (true, text, nil)
        }

        let fallback = String(data: outputData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (true, fallback, nil)
    }
}
