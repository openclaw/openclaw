import Foundation
import OpenClawKit
import os

/// Sends an `agent.request` event to the gateway from an out-of-process context
/// (AppIntent, Shortcuts). Mirrors the pattern used by the Share Extension.
enum AgentIntentGatewayRelay {
    private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "AppIntents")

    struct SendParams: Sendable {
        var message: String
        var thinking: String = "low"
        var sessionKey: String? = nil
    }

    enum RelayError: LocalizedError {
        case notConfigured
        case invalidGatewayURL
        case encodingFailed

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "OpenClaw is not connected to a gateway. Open the app and connect first."
            case .invalidGatewayURL:
                return "Saved gateway URL is invalid. Open the app and reconnect."
            case .encodingFailed:
                return "Failed to encode the request payload."
            }
        }
    }

    private struct AgentRequestPayload: Codable {
        var message: String
        var sessionKey: String?
        var thinking: String
        var deliver: Bool
        var key: String
    }

    private struct NodeEventParams: Codable {
        var event: String
        var payloadJSON: String
    }

    static func send(_ params: SendParams) async throws {
        guard let config = ShareGatewayRelaySettings.loadConfig() else {
            throw RelayError.notConfigured
        }
        guard let url = URL(string: config.gatewayURLString) else {
            throw RelayError.invalidGatewayURL
        }

        let gateway = GatewayNodeSession()
        defer { Task { await gateway.disconnect() } }

        try await Self.connectGateway(gateway, url: url, config: config, clientId: "openclaw-ios")

        let requestPayload = AgentRequestPayload(
            message: params.message,
            sessionKey: params.sessionKey ?? config.sessionKey,
            thinking: params.thinking,
            deliver: false,
            key: UUID().uuidString)

        guard let payloadJSON = String(data: try JSONEncoder().encode(requestPayload), encoding: .utf8) else {
            throw RelayError.encodingFailed
        }
        guard let nodeEventParams = String(
            data: try JSONEncoder().encode(NodeEventParams(event: "agent.request", payloadJSON: payloadJSON)),
            encoding: .utf8)
        else {
            throw RelayError.encodingFailed
        }

        _ = try await gateway.request(method: "node.event", paramsJSON: nodeEventParams, timeoutSeconds: 25)
        Self.logger.info("AppIntents: agent.request sent chars=\(params.message.count, privacy: .public)")
    }

    private static func connectGateway(
        _ gateway: GatewayNodeSession,
        url: URL,
        config: ShareGatewayRelayConfig,
        clientId: String) async throws
    {
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: clientId,
            clientMode: "node",
            clientDisplayName: "OpenClaw Shortcuts",
            includeDeviceIdentity: false)

        do {
            try await gateway.connect(
                url: url,
                token: config.token,
                password: config.password,
                connectOptions: options,
                sessionBox: nil,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .invalidRequest,
                            message: "AppIntents does not support node invoke"))
                })
        } catch {
            guard Self.shouldRetryWithLegacyClientId(error) else { throw error }
            try await connectGateway(gateway, url: url, config: config, clientId: "moltbot-ios")
        }
    }

    /// Some older gateways reject the new clientId format and expect the legacy "moltbot-ios" id.
    private static func shouldRetryWithLegacyClientId(_ error: Error) -> Bool {
        if let e = error as? GatewayResponseError {
            let code = e.code.lowercased()
            let msg = e.message.lowercased()
            let path = (e.details["path"]?.value as? String)?.lowercased() ?? ""
            let mentionsClientId = msg.contains("/client/id") || msg.contains("client id")
                || path.contains("/client/id")
            let isInvalidConnect = (code.contains("invalid") && code.contains("connect"))
                || msg.contains("invalid connect params")
            if isInvalidConnect && mentionsClientId { return true }
        }
        let text = error.localizedDescription.lowercased()
        return text.contains("invalid connect params")
            && (text.contains("/client/id") || text.contains("client id"))
    }
}
