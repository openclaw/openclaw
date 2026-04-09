import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct NodeBackgroundAliveE2ETests {
    private struct NodeListResult: Decodable {
        var nodes: [NodeSummary]
    }

    private struct NodeSummary: Decodable {
        var nodeId: String
        var clientId: String?
        var connected: Bool?
        var lastSeenAtMs: Int?
        var lastSeenReason: String?
    }

    private static let enabledEnvKey = "OPENCLAW_IOS_BACKGROUND_ALIVE_E2E"
    private static let urlEnvKey = "OPENCLAW_IOS_BACKGROUND_ALIVE_E2E_URL"

    @Test @MainActor func reconnectsAndPublishesAliveBeaconAgainstLocalGateway() async throws {
        guard ProcessInfo.processInfo.environment[Self.enabledEnvKey] == "1" else { return }

        let gatewayURL = URL(
            string: ProcessInfo.processInfo.environment[Self.urlEnvKey] ?? "ws://127.0.0.1:18789")!
        let appModel = NodeAppModel()
        let operatorSession = GatewayNodeSession()
        defer {
            appModel.disconnectGateway()
            Task {
                await operatorSession.disconnect()
            }
        }

        try await operatorSession.connect(
            url: gatewayURL,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: ["operator.admin", "operator.read"],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios-background-alive-e2e-operator",
                clientMode: "ui",
                clientDisplayName: "iOS Background Alive E2E"),
            sessionBox: nil,
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .invalidRequest,
                        message: "operator session does not handle node invokes"))
            })

        let nodeOptions = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [OpenClawCapability.device.rawValue],
            commands: [OpenClawDeviceCommand.status.rawValue],
            permissions: [:],
            clientId: "ios-background-alive-e2e-node",
            clientMode: "node",
            clientDisplayName: "iOS Background Alive E2E")
        appModel.applyGatewayConnectConfig(
            GatewayConnectConfig(
                url: gatewayURL,
                stableID: "ios-background-alive-e2e",
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: nodeOptions))

        let initialNode = try await Self.waitForNode(
            operatorSession: operatorSession,
            clientId: nodeOptions.clientId,
            timeoutSeconds: 12)
        let initialLastSeenAtMs = initialNode.lastSeenAtMs ?? 0

        appModel._test_setBackgrounded(true)
        await appModel.gatewaySession.disconnect()
        appModel._test_setGatewayConnected(false)

        let applied = await appModel._test_performBackgroundAliveBeacon(
            trigger: "simulator_e2e",
            wakeId: "sim-e2e")
        #expect(applied)

        let updatedNode = try await Self.waitForNode(
            operatorSession: operatorSession,
            clientId: nodeOptions.clientId,
            timeoutSeconds: 12,
            predicate: { node in
                node.lastSeenReason == "simulator_e2e" && (node.lastSeenAtMs ?? 0) > initialLastSeenAtMs
            })
        #expect(updatedNode.lastSeenReason == "simulator_e2e")
        #expect((updatedNode.lastSeenAtMs ?? 0) > initialLastSeenAtMs)
    }

    private static func waitForNode(
        operatorSession: GatewayNodeSession,
        clientId: String,
        timeoutSeconds: Double,
        predicate: ((NodeSummary) -> Bool)? = nil
    ) async throws -> NodeSummary {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            let payload = try await operatorSession.request(method: "node.list", paramsJSON: "{}", timeoutSeconds: 8)
            let decoded = try JSONDecoder().decode(NodeListResult.self, from: payload)
            if let match = decoded.nodes.first(where: { node in
                node.clientId == clientId && (predicate?(node) ?? true)
            }) {
                return match
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw NSError(
            domain: "NodeBackgroundAliveE2E",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for node \(clientId)"])
    }
}
