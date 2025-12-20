import ClawdisIPC
import ClawdisKit
import Foundation
import OSLog

enum ControlRequestHandler {
    struct NodeListNode: Codable {
        var nodeId: String
        var displayName: String?
        var platform: String?
        var version: String?
        var deviceFamily: String?
        var modelIdentifier: String?
        var remoteAddress: String?
        var connected: Bool
        var paired: Bool
        var capabilities: [String]?
        var commands: [String]?
    }

    struct NodeListResult: Codable {
        var ts: Int
        var connectedNodeIds: [String]
        var pairedNodeIds: [String]
        var nodes: [NodeListNode]
    }

    struct GatewayNodeListPayload: Decodable {
        struct Node: Decodable {
            var nodeId: String
            var displayName: String?
            var platform: String?
            var version: String?
            var deviceFamily: String?
            var modelIdentifier: String?
            var remoteIp: String?
            var connected: Bool?
            var paired: Bool?
            var caps: [String]?
            var commands: [String]?
        }

        var ts: Int?
        var nodes: [Node]
    }

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

        case let .canvasPresent(session, path, placement):
            return await self.handleCanvasPresent(session: session, path: path, placement: placement)

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

        case let .nodeDescribe(nodeId):
            return await self.handleNodeDescribe(nodeId: nodeId)

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

        case let .screenRecord(screenIndex, durationMs, fps, includeAudio, outPath):
            return await self.handleScreenRecord(
                screenIndex: screenIndex,
                durationMs: durationMs,
                fps: fps,
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
            await NotifyOverlayController.shared.present(title: request.title, body: request.body)
            return Response(ok: true)
        case .auto:
            let ok = await notifier.send(
                title: request.title,
                body: request.body,
                sound: chosenSound,
                priority: request.priority)
            if ok { return Response(ok: true) }
            await NotifyOverlayController.shared.present(title: request.title, body: request.body)
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
        let result = await GatewayConnection.shared.status()
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
        let invocation = GatewayAgentInvocation(
            message: trimmed,
            sessionKey: sessionKey,
            thinking: thinking,
            deliver: deliver,
            to: to,
            channel: .last)
        let rpcResult = await GatewayConnection.shared.sendAgent(invocation)
        return rpcResult.ok ? Response(ok: true, message: "sent") : Response(ok: false, message: rpcResult.error)
    }

    private static func canvasEnabled() -> Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
    }

    private static func handleCanvasPresent(
        session: String,
        path: String?,
        placement: CanvasPlacement?) async -> Response
    {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        _ = session
        do {
            var params: [String: Any] = [:]
            if let path, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                params["url"] = path
            }
            if let placement {
                var placementPayload: [String: Any] = [:]
                if let x = placement.x { placementPayload["x"] = x }
                if let y = placement.y { placementPayload["y"] = y }
                if let width = placement.width { placementPayload["width"] = width }
                if let height = placement.height { placementPayload["height"] = height }
                if !placementPayload.isEmpty {
                    params["placement"] = placementPayload
                }
            }
            _ = try await self.invokeLocalNode(
                command: ClawdisCanvasCommand.present.rawValue,
                params: params.isEmpty ? nil : params,
                timeoutMs: 20000)
            return Response(ok: true)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasHide(session: String) async -> Response {
        _ = session
        do {
            _ = try await self.invokeLocalNode(
                command: ClawdisCanvasCommand.hide.rawValue,
                params: nil,
                timeoutMs: 10000)
            return Response(ok: true)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasEval(session: String, javaScript: String) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        _ = session
        do {
            let payload = try await self.invokeLocalNode(
                command: ClawdisCanvasCommand.evalJS.rawValue,
                params: ["javaScript": javaScript],
                timeoutMs: 20000)
            if let dict = payload as? [String: Any],
               let result = dict["result"] as? String
            {
                return Response(ok: true, payload: Data(result.utf8))
            }
            return Response(ok: true)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasSnapshot(session: String, outPath: String?) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        _ = session
        do {
            let payload = try await self.invokeLocalNode(
                command: ClawdisCanvasCommand.snapshot.rawValue,
                params: [:],
                timeoutMs: 20000)
            guard let dict = payload as? [String: Any],
                  let format = dict["format"] as? String,
                  let base64 = dict["base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return Response(ok: false, message: "invalid canvas snapshot payload")
            }
            let ext = (format.lowercased() == "jpeg" || format.lowercased() == "jpg") ? "jpg" : "png"
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-canvas-snapshot-\(UUID().uuidString).\(ext)")
            }
            try data.write(to: url, options: [.atomic])
            return Response(ok: true, message: url.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasA2UI(
        session: String,
        command: CanvasA2UICommand,
        jsonl: String?) async -> Response
    {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        _ = session
        do {
            switch command {
            case .reset:
                let payload = try await self.invokeLocalNode(
                    command: ClawdisCanvasA2UICommand.reset.rawValue,
                    params: nil,
                    timeoutMs: 20000)
                if let payload {
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    return Response(ok: true, payload: data)
                }
                return Response(ok: true)
            case .pushJSONL:
                guard let jsonl, !jsonl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return Response(ok: false, message: "missing jsonl")
                }
                let payload = try await self.invokeLocalNode(
                    command: ClawdisCanvasA2UICommand.pushJSONL.rawValue,
                    params: ["jsonl": jsonl],
                    timeoutMs: 30000)
                if let payload {
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    return Response(ok: true, payload: data)
                }
                return Response(ok: true)
            }
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleNodeList() async -> Response {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "node.list",
                params: [:],
                timeoutMs: 10000)
            let payload = try JSONDecoder().decode(GatewayNodeListPayload.self, from: data)
            let result = self.buildNodeListResult(payload: payload)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let json = (try? encoder.encode(result))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return Response(ok: true, payload: Data(json.utf8))
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleNodeDescribe(nodeId: String) async -> Response {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "node.describe",
                params: ["nodeId": AnyCodable(nodeId)],
                timeoutMs: 10000)
            return Response(ok: true, payload: data)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    static func buildNodeListResult(payload: GatewayNodeListPayload) -> NodeListResult {
        let nodes = payload.nodes.map { n -> NodeListNode in
            NodeListNode(
                nodeId: n.nodeId,
                displayName: n.displayName,
                platform: n.platform,
                version: n.version,
                deviceFamily: n.deviceFamily,
                modelIdentifier: n.modelIdentifier,
                remoteAddress: n.remoteIp,
                connected: n.connected == true,
                paired: n.paired == true,
                capabilities: n.caps,
                commands: n.commands)
        }

        let sorted = nodes.sorted { a, b in
            (a.displayName ?? a.nodeId) < (b.displayName ?? b.nodeId)
        }

        let pairedNodeIds = sorted.filter(\.paired).map(\.nodeId).sorted()
        let connectedNodeIds = sorted.filter(\.connected).map(\.nodeId).sorted()

        return NodeListResult(
            ts: payload.ts ?? Int(Date().timeIntervalSince1970 * 1000),
            connectedNodeIds: connectedNodeIds,
            pairedNodeIds: pairedNodeIds,
            nodes: sorted)
    }

    private static func handleNodeInvoke(
        nodeId: String,
        command: String,
        paramsJSON: String?,
        logger: Logger) async -> Response
    {
        do {
            var paramsObj: Any?
            let raw = (paramsJSON ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !raw.isEmpty {
                if let data = raw.data(using: .utf8) {
                    paramsObj = try JSONSerialization.jsonObject(with: data)
                } else {
                    return Response(ok: false, message: "params-json not UTF-8")
                }
            }

            var params: [String: AnyCodable] = [
                "nodeId": AnyCodable(nodeId),
                "command": AnyCodable(command),
                "idempotencyKey": AnyCodable(UUID().uuidString),
            ]
            if let paramsObj {
                params["params"] = AnyCodable(paramsObj)
            }

            let data = try await GatewayConnection.shared.request(
                method: "node.invoke",
                params: params,
                timeoutMs: 30000)
            return Response(ok: true, payload: data)
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
            var params: [String: Any] = [:]
            if let facing { params["facing"] = facing.rawValue }
            if let maxWidth { params["maxWidth"] = maxWidth }
            if let quality { params["quality"] = quality }
            params["format"] = "jpg"

            let payload = try await self.invokeLocalNode(
                command: ClawdisCameraCommand.snap.rawValue,
                params: params,
                timeoutMs: 30000)
            guard let dict = payload as? [String: Any],
                  let format = dict["format"] as? String,
                  let base64 = dict["base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return Response(ok: false, message: "invalid camera snapshot payload")
            }

            let ext = (format.lowercased() == "jpeg" || format.lowercased() == "jpg") ? "jpg" : format.lowercased()
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-camera-snap-\(UUID().uuidString).\(ext)")
            }

            try data.write(to: url, options: [.atomic])
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
            var params: [String: Any] = ["includeAudio": includeAudio, "format": "mp4"]
            if let facing { params["facing"] = facing.rawValue }
            if let durationMs { params["durationMs"] = durationMs }

            let payload = try await self.invokeLocalNode(
                command: ClawdisCameraCommand.clip.rawValue,
                params: params,
                timeoutMs: 90000)
            guard let dict = payload as? [String: Any],
                  let format = dict["format"] as? String,
                  let base64 = dict["base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return Response(ok: false, message: "invalid camera clip payload")
            }

            let ext = format.lowercased()
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-camera-clip-\(UUID().uuidString).\(ext)")
            }
            try data.write(to: url, options: [.atomic])
            return Response(ok: true, message: url.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleScreenRecord(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool,
        outPath: String?) async -> Response
    {
        do {
            var params: [String: Any] = ["format": "mp4", "includeAudio": includeAudio]
            if let screenIndex { params["screenIndex"] = screenIndex }
            if let durationMs { params["durationMs"] = durationMs }
            if let fps { params["fps"] = fps }

            let payload = try await self.invokeLocalNode(
                command: "screen.record",
                params: params,
                timeoutMs: 120_000)
            guard let dict = payload as? [String: Any],
                  let base64 = dict["base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return Response(ok: false, message: "invalid screen record payload")
            }
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-screen-record-\(UUID().uuidString).mp4")
            }
            try data.write(to: url, options: [.atomic])
            return Response(ok: true, message: url.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func invokeLocalNode(
        command: String,
        params: [String: Any]?,
        timeoutMs: Double) async throws -> Any?
    {
        var gatewayParams: [String: AnyCodable] = [
            "nodeId": AnyCodable(Self.localNodeId()),
            "command": AnyCodable(command),
            "idempotencyKey": AnyCodable(UUID().uuidString),
        ]
        if let params {
            gatewayParams["params"] = AnyCodable(params)
        }
        let data = try await GatewayConnection.shared.request(
            method: "node.invoke",
            params: gatewayParams,
            timeoutMs: timeoutMs)
        return try Self.decodeNodeInvokePayload(data: data)
    }

    private static func decodeNodeInvokePayload(data: Data) throws -> Any? {
        let obj = try JSONSerialization.jsonObject(with: data)
        guard let dict = obj as? [String: Any] else {
            throw NSError(domain: "Node", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "invalid node invoke response",
            ])
        }
        return dict["payload"]
    }

    private static func localNodeId() -> String {
        "mac-\(InstanceIdentity.instanceId)"
    }
}
