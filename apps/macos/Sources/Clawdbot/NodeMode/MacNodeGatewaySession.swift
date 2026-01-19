import ClawdbotKit
import ClawdbotProtocol
import Foundation
import OSLog

private struct NodeInvokeRequestPayload: Codable, Sendable {
    var id: String
    var nodeId: String
    var command: String
    var paramsJSON: String?
    var timeoutMs: Int?
    var idempotencyKey: String?
}

actor MacNodeGatewaySession {
    private let logger = Logger(subsystem: "com.clawdbot", category: "node.gateway")
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var channel: GatewayChannelActor?
    private var activeURL: URL?
    private var activeToken: String?
    private var activePassword: String?
    private var connectOptions: GatewayConnectOptions?
    private var onConnected: (@Sendable () async -> Void)?
    private var onDisconnected: (@Sendable (String) async -> Void)?
    private var onInvoke: (@Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)?

    func connect(
        url: URL,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse
    ) async throws {
        let shouldReconnect = self.activeURL != url ||
            self.activeToken != token ||
            self.activePassword != password ||
            self.channel == nil

        self.connectOptions = connectOptions
        self.onConnected = onConnected
        self.onDisconnected = onDisconnected
        self.onInvoke = onInvoke

        if shouldReconnect {
            if let existing = self.channel {
                await existing.shutdown()
            }
            let channel = GatewayChannelActor(
                url: url,
                token: token,
                password: password,
                session: sessionBox,
                pushHandler: { [weak self] push in
                    await self?.handlePush(push)
                },
                connectOptions: connectOptions,
                disconnectHandler: { [weak self] reason in
                    await self?.onDisconnected?(reason)
                })
            self.channel = channel
            self.activeURL = url
            self.activeToken = token
            self.activePassword = password
        }

        guard let channel = self.channel else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "gateway channel unavailable",
            ])
        }

        do {
            try await channel.connect()
            await onConnected()
        } catch {
            await onDisconnected(error.localizedDescription)
            throw error
        }
    }

    func disconnect() async {
        await self.channel?.shutdown()
        self.channel = nil
        self.activeURL = nil
        self.activeToken = nil
        self.activePassword = nil
    }

    func sendEvent(event: String, payloadJSON: String?) async {
        guard let channel = self.channel else { return }
        let params: [String: ClawdbotProtocol.AnyCodable] = [
            "event": ClawdbotProtocol.AnyCodable(event),
            "payloadJSON": ClawdbotProtocol.AnyCodable(payloadJSON ?? NSNull()),
        ]
        do {
            _ = try await channel.request(method: "node.event", params: params, timeoutMs: 8000)
        } catch {
            self.logger.error("node event failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handlePush(_ push: GatewayPush) async {
        switch push {
        case let .event(evt):
            await self.handleEvent(evt)
        default:
            break
        }
    }

    private func handleEvent(_ evt: EventFrame) async {
        guard evt.event == "node.invoke.request" else { return }
        guard let payload = evt.payload else { return }
        do {
            let data = try self.encoder.encode(payload)
            let request = try self.decoder.decode(NodeInvokeRequestPayload.self, from: data)
            guard let onInvoke else { return }
            let req = BridgeInvokeRequest(id: request.id, command: request.command, paramsJSON: request.paramsJSON)
            let response = await onInvoke(req)
            await self.sendInvokeResult(request: request, response: response)
        } catch {
            self.logger.error("node invoke decode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendInvokeResult(request: NodeInvokeRequestPayload, response: BridgeInvokeResponse) async {
        guard let channel = self.channel else { return }
        var params: [String: ClawdbotProtocol.AnyCodable] = [
            "id": ClawdbotProtocol.AnyCodable(request.id),
            "nodeId": ClawdbotProtocol.AnyCodable(request.nodeId),
            "ok": ClawdbotProtocol.AnyCodable(response.ok),
            "payloadJSON": ClawdbotProtocol.AnyCodable(response.payloadJSON ?? NSNull()),
        ]
        if let error = response.error {
            params["error"] = ClawdbotProtocol.AnyCodable([
                "code": ClawdbotProtocol.AnyCodable(error.code.rawValue),
                "message": ClawdbotProtocol.AnyCodable(error.message),
            ])
        }
        do {
            _ = try await channel.request(method: "node.invoke.result", params: params, timeoutMs: 15000)
        } catch {
            self.logger.error("node invoke result failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
