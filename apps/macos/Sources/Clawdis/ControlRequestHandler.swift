import ClawdisIPC
import Foundation
import OSLog

enum ControlRequestHandler {
    static func process(
        request: Request,
        notifier: NotificationManager = NotificationManager(),
        logger: Logger = Logger(subsystem: "com.steipete.clawdis", category: "control")) async throws -> Response
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
}
