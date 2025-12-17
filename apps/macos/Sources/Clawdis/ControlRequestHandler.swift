import ClawdisIPC
import Foundation
import OSLog

enum ControlRequestHandler {
    private static let cameraCapture = CameraCaptureService()

    static func process(
        request: Request,
        notifier: NotificationManager = NotificationManager(),
        logger: Logger = Logger(subsystem: "com.steipete.clawdis", category: "control")) async throws -> Response
    {
        // Keep `status` responsive even if the main actor is busy.
        let paused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        if paused, case .status = request {
            // allow status through
        } else if paused {
            return Response(ok: false, message: "clawdis paused")
        }

        switch request {
        case let .notify(title, body, sound, priority, delivery):
            let notify = NotifyRequest(
                title: title,
                body: body,
                sound: sound,
                priority: priority,
                delivery: delivery)
            return await self.handleNotify(notify, notifier: notifier)

        case let .ensurePermissions(caps, interactive):
            return await self.handleEnsurePermissions(caps: caps, interactive: interactive)

        case .status:
            return paused
                ? Response(ok: false, message: "clawdis paused")
                : Response(ok: true, message: "ready")

        case .rpcStatus:
            return await self.handleRPCStatus()

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            return await self.handleRunShell(
                command: command,
                cwd: cwd,
                env: env,
                timeoutSec: timeoutSec,
                needsSR: needsSR)

        case let .agent(message, thinking, session, deliver, to):
            return await self.handleAgent(
                message: message,
                thinking: thinking,
                session: session,
                deliver: deliver,
                to: to)

        case let .canvasShow(session, path, placement):
            return await self.handleCanvasShow(session: session, path: path, placement: placement)

        case let .canvasHide(session):
            return await self.handleCanvasHide(session: session)

        case let .canvasEval(session, javaScript):
            return await self.handleCanvasEval(session: session, javaScript: javaScript)

        case let .canvasSnapshot(session, outPath):
            return await self.handleCanvasSnapshot(session: session, outPath: outPath)

        case let .canvasA2UI(session, command, jsonl):
            return await self.handleCanvasA2UI(session: session, command: command, jsonl: jsonl)

        case .nodeList:
            return await self.handleNodeList()

        case let .nodeInvoke(nodeId, command, paramsJSON):
            return await self.handleNodeInvoke(
                nodeId: nodeId,
                command: command,
                paramsJSON: paramsJSON,
                logger: logger)

        case let .cameraSnap(facing, maxWidth, quality, outPath):
            return await self.handleCameraSnap(facing: facing, maxWidth: maxWidth, quality: quality, outPath: outPath)

        case let .cameraClip(facing, durationMs, includeAudio, outPath):
            return await self.handleCameraClip(
                facing: facing,
                durationMs: durationMs,
                includeAudio: includeAudio,
                outPath: outPath)
        }
    }

    private struct NotifyRequest {
        var title: String
        var body: String
        var sound: String?
        var priority: NotificationPriority?
        var delivery: NotificationDelivery?
    }

    private static func handleNotify(_ request: NotifyRequest, notifier: NotificationManager) async -> Response {
        let chosenSound = request.sound?.trimmingCharacters(in: .whitespacesAndNewlines)
        let chosenDelivery = request.delivery ?? .system

        switch chosenDelivery {
        case .system:
            let ok = await notifier.send(
                title: request.title,
                body: request.body,
                sound: chosenSound,
                priority: request.priority)
            return ok ? Response(ok: true) : Response(ok: false, message: "notification not authorized")
        case .overlay:
            await MainActor.run {
                NotifyOverlayController.shared.present(title: request.title, body: request.body)
            }
            return Response(ok: true)
        case .auto:
            let ok = await notifier.send(
                title: request.title,
                body: request.body,
                sound: chosenSound,
                priority: request.priority)
            if ok { return Response(ok: true) }
            await MainActor.run {
                NotifyOverlayController.shared.present(title: request.title, body: request.body)
            }
            return Response(ok: true, message: "notification not authorized; used overlay")
        }
    }

    private static func handleEnsurePermissions(caps: [Capability], interactive: Bool) async -> Response {
        let statuses = await PermissionManager.ensure(caps, interactive: interactive)
        let missing = statuses.filter { !$0.value }.map(\.key.rawValue)
        let ok = missing.isEmpty
        let msg = ok ? "all granted" : "missing: \(missing.joined(separator: ","))"
        return Response(ok: ok, message: msg)
    }

    private static func handleRPCStatus() async -> Response {
        let result = await AgentRPC.shared.status()
        return Response(ok: result.ok, message: result.error)
    }

    private static func handleRunShell(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeoutSec: Double?,
        needsSR: Bool) async -> Response
    {
        if needsSR {
            let authorized = await PermissionManager
                .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
            guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
        }
        return await ShellExecutor.run(command: command, cwd: cwd, env: env, timeout: timeoutSec)
    }

    private static func handleAgent(
        message: String,
        thinking: String?,
        session: String?,
        deliver: Bool,
        to: String?) async -> Response
    {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Response(ok: false, message: "message empty") }
        let sessionKey = session ?? "main"
        let rpcResult = await AgentRPC.shared.send(
            text: trimmed,
            thinking: thinking,
            sessionKey: sessionKey,
            deliver: deliver,
            to: to,
            channel: nil)
        return rpcResult.ok
            ? Response(ok: true, message: rpcResult.text ?? "sent")
            : Response(ok: false, message: rpcResult.error ?? "failed to send")
    }

    private static func canvasEnabled() -> Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? true
    }

    private static func handleCanvasShow(
        session: String,
        path: String?,
        placement: CanvasPlacement?) async -> Response
    {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            let res = try await MainActor.run {
                try CanvasManager.shared.showDetailed(sessionKey: session, target: path, placement: placement)
            }
            let payload = try? JSONEncoder().encode(res)
            return Response(ok: true, message: res.directory, payload: payload)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasHide(session: String) async -> Response {
        await MainActor.run { CanvasManager.shared.hide(sessionKey: session) }
        return Response(ok: true)
    }

    private static func handleCanvasEval(session: String, javaScript: String) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            let result = try await CanvasManager.shared.eval(sessionKey: session, javaScript: javaScript)
            return Response(ok: true, payload: Data(result.utf8))
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasSnapshot(session: String, outPath: String?) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            let path = try await CanvasManager.shared.snapshot(sessionKey: session, outPath: outPath)
            return Response(ok: true, message: path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasA2UI(session: String, command: CanvasA2UICommand, jsonl: String?) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            // Ensure the Canvas is visible and the default page is loaded.
            _ = try await MainActor.run {
                try CanvasManager.shared.show(sessionKey: session, path: "/")
            }

            let ready = await Self.waitForCanvasA2UI(session: session, timeoutMs: 2_000)
            guard ready else { return Response(ok: false, message: "A2UI not ready") }

            let js: String
            switch command {
            case .reset:
                js = """
                (() => {
                  try {
                    if (!globalThis.clawdisA2UI) { return JSON.stringify({ ok: false, error: "missing clawdisA2UI" }); }
                    return JSON.stringify(globalThis.clawdisA2UI.reset());
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e?.message ?? e), stack: e?.stack });
                  }
                })()
                """

            case .pushJSONL:
                guard let jsonl, !jsonl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return Response(ok: false, message: "missing jsonl")
                }
                let items: [ParsedJSONLItem]
                do {
                    items = try Self.parseJSONL(jsonl)
                } catch {
                    return Response(ok: false, message: "invalid jsonl: \(error.localizedDescription)")
                }

                do {
                    try Self.validateA2UIV0_8(items)
                } catch {
                    return Response(ok: false, message: error.localizedDescription)
                }

                let messages = items.map(\.value)
                let data = try JSONSerialization.data(withJSONObject: messages, options: [])
                let json = String(data: data, encoding: .utf8) ?? "[]"
                js = """
                (() => {
                  try {
                    if (!globalThis.clawdisA2UI) { return JSON.stringify({ ok: false, error: "missing clawdisA2UI" }); }
                    const messages = \(json);
                    return JSON.stringify(globalThis.clawdisA2UI.applyMessages(messages));
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e?.message ?? e), stack: e?.stack });
                  }
                })()
                """
            }

            let result = try await CanvasManager.shared.eval(sessionKey: session, javaScript: js)

            let payload = Data(result.utf8)
            if let obj = try? JSONSerialization.jsonObject(with: payload, options: []) as? [String: Any],
               let ok = obj["ok"] as? Bool
            {
                let error = obj["error"] as? String
                return Response(ok: ok, message: ok ? "" : (error ?? "A2UI error"), payload: payload)
            }

            return Response(ok: true, payload: payload)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private struct ParsedJSONLItem {
        let lineNumber: Int
        let value: Any
    }

    private static func parseJSONL(_ text: String) throws -> [ParsedJSONLItem] {
        var out: [ParsedJSONLItem] = []
        var lineNumber = 0
        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            lineNumber += 1
            let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            let data = Data(line.utf8)
            let obj = try JSONSerialization.jsonObject(with: data, options: [])
            out.append(ParsedJSONLItem(lineNumber: lineNumber, value: obj))
        }
        return out
    }

    private static func validateA2UIV0_8(_ items: [ParsedJSONLItem]) throws {
        let allowed = Set(["beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface"])
        for item in items {
            guard let dict = item.value as? [String: Any] else {
                throw NSError(domain: "A2UI", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "A2UI JSONL line \(item.lineNumber): expected a JSON object",
                ])
            }

            if dict.keys.contains("createSurface") {
                throw NSError(domain: "A2UI", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): looks like A2UI v0.9 (`createSurface`).
                    Canvas currently supports A2UI v0.8 server→client messages (`beginRendering`, `surfaceUpdate`, `dataModelUpdate`, `deleteSurface`).
                    """,
                ])
            }

            let matched = dict.keys.filter { allowed.contains($0) }
            if matched.count != 1 {
                let found = dict.keys.sorted().joined(separator: ", ")
                throw NSError(domain: "A2UI", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): expected exactly one of \(allowed.sorted().joined(separator: ", ")); found: \(found)
                    """,
                ])
            }
        }
    }

    private static func waitForCanvasA2UI(session: String, timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await CanvasManager.shared.eval(
                    sessionKey: session,
                    javaScript: "(() => globalThis.clawdisA2UI ? 'ready' : '')()")
                if res == "ready" { return true }
            } catch {
                // Ignore; keep waiting.
            }
            try? await Task.sleep(nanoseconds: 60_000_000)
        }
        return false
    }

    private static func handleNodeList() async -> Response {
        let ids = await BridgeServer.shared.connectedNodeIds()
        let payload = (try? JSONSerialization.data(
            withJSONObject: ["connectedNodeIds": ids],
            options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return Response(ok: true, payload: Data(payload.utf8))
    }

    private static func handleNodeInvoke(
        nodeId: String,
        command: String,
        paramsJSON: String?,
        logger: Logger) async -> Response
    {
        do {
            let res = try await BridgeServer.shared.invoke(nodeId: nodeId, command: command, paramsJSON: paramsJSON)
            if res.ok {
                let payload = res.payloadJSON ?? ""
                return Response(ok: true, payload: Data(payload.utf8))
            }
            let errText = res.error?.message ?? "node invoke failed"
            return Response(ok: false, message: errText)
        } catch {
            logger.error("node invoke failed: \(error.localizedDescription, privacy: .public)")
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCameraSnap(
        facing: CameraFacing?,
        maxWidth: Int?,
        quality: Double?,
        outPath: String?) async -> Response
    {
        guard self.cameraEnabled() else { return Response(ok: false, message: "Camera disabled by user") }
        do {
            let res = try await self.cameraCapture.snap(facing: facing, maxWidth: maxWidth, quality: quality)
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-camera-snap-\(UUID().uuidString).jpg")
            }

            try res.data.write(to: url, options: [.atomic])
            return Response(ok: true, message: url.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCameraClip(
        facing: CameraFacing?,
        durationMs: Int?,
        includeAudio: Bool,
        outPath: String?) async -> Response
    {
        guard self.cameraEnabled() else { return Response(ok: false, message: "Camera disabled by user") }
        do {
            let res = try await self.cameraCapture.clip(
                facing: facing,
                durationMs: durationMs,
                includeAudio: includeAudio,
                outPath: outPath)
            return Response(ok: true, message: res.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }
}
