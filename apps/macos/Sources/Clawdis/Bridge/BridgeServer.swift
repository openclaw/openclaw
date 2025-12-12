import AppKit
import ClawdisNodeKit
import Foundation
import Network
import OSLog

actor BridgeServer {
    static let shared = BridgeServer()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "bridge")
    private var listener: NWListener?
    private var isRunning = false
    private var store: PairedNodesStore?
    private var connections: [String: BridgeConnectionHandler] = [:]

    func start() async {
        if self.isRunning { return }
        self.isRunning = true

        do {
            let storeURL = try Self.defaultStoreURL()
            let store = PairedNodesStore(fileURL: storeURL)
            await store.load()
            self.store = store

            let params = NWParameters.tcp
            let listener = try NWListener(using: params, on: .any)

            let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
            listener.service = NWListener.Service(
                name: "\(name) (Clawdis)",
                type: ClawdisBonjour.bridgeServiceType,
                domain: ClawdisBonjour.bridgeServiceDomain,
                txtRecord: nil)

            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { return }
                Task { await self.handle(connection: connection) }
            }

            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                Task { await self.handleListenerState(state) }
            }

            listener.start(queue: DispatchQueue(label: "com.steipete.clawdis.bridge"))
            self.listener = listener
        } catch {
            self.logger.error("bridge start failed: \(error.localizedDescription, privacy: .public)")
            self.isRunning = false
        }
    }

    func stop() async {
        self.isRunning = false
        self.listener?.cancel()
        self.listener = nil
    }

    private func handleListenerState(_ state: NWListener.State) {
        switch state {
        case .ready:
            self.logger.info("bridge listening")
        case let .failed(err):
            self.logger.error("bridge listener failed: \(err.localizedDescription, privacy: .public)")
        case .cancelled:
            self.logger.info("bridge listener cancelled")
        case .waiting:
            self.logger.info("bridge listener waiting")
        case .setup:
            break
        @unknown default:
            break
        }
    }

    private func handle(connection: NWConnection) async {
        let handler = BridgeConnectionHandler(connection: connection, logger: self.logger)
        await handler.run(
            resolveAuth: { [weak self] hello in
                await self?.authorize(hello: hello) ?? .error(code: "UNAVAILABLE", message: "bridge unavailable")
            },
            handlePair: { [weak self] request in
                await self?.pair(request: request) ?? .error(code: "UNAVAILABLE", message: "bridge unavailable")
            },
            onAuthenticated: { [weak self] nodeId in
                await self?.registerConnection(handler: handler, nodeId: nodeId)
            },
            onDisconnected: { [weak self] nodeId in
                await self?.unregisterConnection(nodeId: nodeId)
            },
            onEvent: { [weak self] nodeId, evt in
                await self?.handleEvent(nodeId: nodeId, evt: evt)
            })
    }

    func invoke(nodeId: String, command: String, paramsJSON: String?) async throws -> BridgeInvokeResponse {
        guard let handler = self.connections[nodeId] else {
            throw NSError(domain: "Bridge", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "UNAVAILABLE: node not connected",
            ])
        }
        return try await handler.invoke(command: command, paramsJSON: paramsJSON)
    }

    func connectedNodeIds() -> [String] {
        Array(self.connections.keys).sorted()
    }

    private func registerConnection(handler: BridgeConnectionHandler, nodeId: String) async {
        self.connections[nodeId] = handler
        await self.beacon(text: "Node connected", nodeId: nodeId, tags: ["node", "ios"])
    }

    private func unregisterConnection(nodeId: String) async {
        self.connections.removeValue(forKey: nodeId)
        await self.beacon(text: "Node disconnected", nodeId: nodeId, tags: ["node", "ios"])
    }

    private struct VoiceTranscriptPayload: Codable, Sendable {
        var text: String
        var sessionKey: String?
    }

    private func handleEvent(nodeId: String, evt: BridgeEventFrame) async {
        switch evt.event {
        case "voice.transcript":
            guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else {
                return
            }
            guard let payload = try? JSONDecoder().decode(VoiceTranscriptPayload.self, from: data) else {
                return
            }
            let text = payload.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }

            let sessionKey = payload.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? "node-\(nodeId)"

            _ = await AgentRPC.shared.send(
                text: text,
                thinking: "low",
                sessionKey: sessionKey,
                deliver: false,
                to: nil,
                channel: "last")
        default:
            break
        }
    }

    private func beacon(text: String, nodeId: String, tags: [String]) async {
        do {
            let params: [String: Any] = [
                "text": "\(text): \(nodeId)",
                "instanceId": nodeId,
                "mode": "node",
                "tags": tags,
            ]
            _ = try await AgentRPC.shared.controlRequest(
                method: "system-event",
                params: ControlRequestParams(raw: params))
        } catch {
            // Best-effort only.
        }
    }

    private func authorize(hello: BridgeHello) async -> BridgeConnectionHandler.AuthResult {
        let nodeId = hello.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
        if nodeId.isEmpty {
            return .error(code: "INVALID_REQUEST", message: "nodeId required")
        }
        guard let store = self.store else {
            return .error(code: "UNAVAILABLE", message: "store unavailable")
        }
        guard let paired = await store.find(nodeId: nodeId) else {
            return .notPaired
        }
        guard let token = hello.token, token == paired.token else {
            return .unauthorized
        }
        do { try await store.touchSeen(nodeId: nodeId) } catch { /* ignore */ }
        return .ok
    }

    private func pair(request: BridgePairRequest) async -> BridgeConnectionHandler.PairResult {
        let nodeId = request.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
        if nodeId.isEmpty {
            return .error(code: "INVALID_REQUEST", message: "nodeId required")
        }
        guard let store = self.store else {
            return .error(code: "UNAVAILABLE", message: "store unavailable")
        }
        let existing = await store.find(nodeId: nodeId)

        let approved = await BridgePairingApprover.approve(request: request, isRepair: existing != nil)
        if !approved {
            return .rejected
        }

        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let node = PairedNode(
            nodeId: nodeId,
            displayName: request.displayName,
            platform: request.platform,
            version: request.version,
            token: token,
            createdAtMs: nowMs,
            lastSeenAtMs: nowMs)
        do {
            try await store.upsert(node)
            return .ok(token: token)
        } catch {
            return .error(code: "UNAVAILABLE", message: "failed to persist pairing")
        }
    }

    private static func defaultStoreURL() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let base else {
            throw NSError(
                domain: "Bridge",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Application Support unavailable"])
        }
        return base
            .appendingPathComponent("Clawdis", isDirectory: true)
            .appendingPathComponent("bridge", isDirectory: true)
            .appendingPathComponent("paired-nodes.json", isDirectory: false)
    }
}

@MainActor
enum BridgePairingApprover {
    static func approve(request: BridgePairRequest, isRepair: Bool) async -> Bool {
        await withCheckedContinuation { cont in
            let name = request.displayName ?? request.nodeId
            let alert = NSAlert()
            alert.messageText = isRepair ? "Re-pair Clawdis Node?" : "Pair Clawdis Node?"
            alert.informativeText = """
            Node: \(name)
            Platform: \(request.platform ?? "unknown")
            Version: \(request.version ?? "unknown")
            """
            alert.addButton(withTitle: "Approve")
            alert.addButton(withTitle: "Reject")
            let resp = alert.runModal()
            cont.resume(returning: resp == .alertFirstButtonReturn)
        }
    }
}

extension String {
    fileprivate var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
