import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit) struct GatewayStatusBuilderTests {
    @Test @MainActor func `connected node does not report disconnected operator chat as connected`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        appModel.apply(.connected(GatewaySessionInfo(serverName: "gateway.example.com")), to: .node, route: nil)

        #expect(GatewayStatusBuilder.build(appModel: appModel) == .connected)
        #expect(GatewayStatusBuilder.buildChat(appModel: appModel) == .disconnected)
    }

    @Test @MainActor func `a dropped node socket reconnects, and chat follows it without an operator`() async throws {
        try await GatewaySessionPauseTests.withFixtureGateway { server, appModel in
            try await TestWait.observed("node connected") { appModel.gatewayConnected }
            // The fixture issues no operator credential, so no operator loop runs, as in bootstrap pairing.
            #expect(appModel.connection.operator == .idle)
            #expect(GatewayStatusBuilder.buildChat(appModel: appModel) == .disconnected)

            server.closeConnection(at: 0)
            try await TestWait.observed("node dropped") { !appModel.gatewayConnected }

            // GatewayChannel reconnects the socket; no surface may flash Offline meanwhile.
            #expect(appModel.connection.node == .connecting(reconnect: true))
            #expect(GatewayStatusBuilder.build(appModel: appModel) == .connecting)
            #expect(GatewayStatusBuilder.buildChat(appModel: appModel) == .connecting)
        }
    }

    @Test @MainActor func `an operator pause shows on the operator row while the node stays up`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        appModel.apply(.connected(GatewaySessionInfo(serverName: "gateway.example.com")), to: .node, route: nil)
        let problem = try #require(GatewayConnectionProblemMapper.map(error: GatewayConnectAuthError(
            message: "too many failed authentication attempts",
            detailCode: "AUTH_RATE_LIMITED",
            canRetryWithDeviceToken: false)))

        appModel.applyOperatorGatewayConnectionProblem(problem, route: nil)

        #expect(appModel.operatorStatusText == problem.localizedStatusText)
    }

    @Test @MainActor func `an unmapped node connect error shows its cause without pausing`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }

        let problem = appModel._test_applyNodeGatewayConnectionError(URLError(.badServerResponse))

        #expect(GatewayStatusBuilder.build(appModel: appModel) == .error)
        #expect(GatewayConnectionIssue.detect(problem: appModel.lastGatewayProblem) != .none)
        #expect(!problem.pauseReconnect)
        #expect(appModel.connection.node == .connecting(reconnect: true))
    }

    @Test @MainActor func `a reconnecting operator leaves the gateway online and chat connecting`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        appModel.apply(.connected(GatewaySessionInfo(serverName: "gateway.example.com")), to: .node, route: nil)
        appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)

        appModel.apply(.dropped, to: .operator, route: nil)

        #expect(GatewayStatusBuilder.build(appModel: appModel) == .connected)
        #expect(GatewayStatusBuilder.buildChat(appModel: appModel) == .connecting)
        #expect(appModel.connection.operator == .connecting(reconnect: true))
    }

    @Test func `an action notice stays readable while the node is connected`() {
        let connection = GatewayConnection(
            node: .connected(GatewaySessionInfo(serverName: "gateway.example.com")),
            operator: .connected(GatewaySessionInfo()))
        let notice = "Could not remove offline data for this gateway"

        let source = GatewayStatusBuilder.source(
            for: connection.node,
            connection: connection,
            lastGatewayProblem: nil,
            progress: nil,
            notice: notice)

        #expect(source.statusText == notice)
        #expect(source.displayState == .connected)
    }

    @Test(arguments: [nil, "gateway.example.com"] as [String?])
    func `paused problem keeps error status`(_ gatewayServerName: String?) {
        let problem = GatewayConnectionProblem(
            kind: .pairingRequired,
            owner: .gateway,
            title: "Pairing required",
            message: "Approve this device before reconnecting.",
            requestId: "req-123",
            retryable: false,
            pauseReconnect: true)
        let state = GatewayStatusBuilder.build(
            connection: GatewayConnection(
                node: gatewayServerName.map { .connected(GatewaySessionInfo(serverName: $0)) } ?? .paused(problem),
                operator: .paused(problem)),
            lastGatewayProblem: nil,
            progress: nil)

        #expect(state == .error)
    }

    @Test(arguments: [nil, "gateway.example.com"] as [String?])
    func `transient problem keeps error status while reconnecting`(_ gatewayServerName: String?) {
        let state = GatewayStatusBuilder.build(
            connection: GatewayConnection(
                node: gatewayServerName.map { .connected(GatewaySessionInfo(serverName: $0)) }
                    ?? .connecting(reconnect: true)),
            lastGatewayProblem: GatewayConnectionProblem(
                kind: .timeout,
                owner: .network,
                title: "Connection timed out",
                message: "The gateway did not respond before the connection timed out.",
                retryable: true,
                pauseReconnect: false),
            progress: nil)

        #expect(state == .error)
    }

    @Test func `chat gateway status labels match display state`() {
        #expect(ChatProTab.gatewayStatusTitle(state: .disconnected, isGatewayUsable: false) == "Offline")
        #expect(ChatProTab.gatewayStatusTitle(state: .connecting, isGatewayUsable: false) == "Connecting")
        #expect(ChatProTab.gatewayStatusTitle(state: .error, isGatewayUsable: false) == "Attention")
        #expect(ChatProTab.gatewayStatusTitle(state: .connected, isGatewayUsable: true) == "Connected")
        #expect(ChatProTab.gatewayStatusTitle(state: .connected, isGatewayUsable: false) == "Unavailable")
    }

    @Test func `chat gateway status tones separate healthy issue and offline states`() {
        #expect(ChatProTab.gatewayStatusTone(state: .connected, isGatewayUsable: true) == .success)
        #expect(ChatProTab.gatewayStatusTone(state: .connected, isGatewayUsable: false) == .warning)
        #expect(ChatProTab.gatewayStatusTone(state: .connecting, isGatewayUsable: false) == .warning)
        #expect(ChatProTab.gatewayStatusTone(state: .error, isGatewayUsable: false) == .warning)
        #expect(ChatProTab.gatewayStatusTone(state: .disconnected, isGatewayUsable: false) == .error)
    }

    @Test func `chat gateway status expands on tap or whenever gateway needs attention`() {
        #expect(!ChatProTab.gatewayStatusShouldExpand(
            state: .connected,
            isGatewayUsable: true,
            isManuallyExpanded: false))
        #expect(ChatProTab.gatewayStatusShouldExpand(
            state: .connected,
            isGatewayUsable: true,
            isManuallyExpanded: true))
        #expect(ChatProTab.gatewayStatusShouldExpand(
            state: .connecting,
            isGatewayUsable: false,
            isManuallyExpanded: false))
        #expect(ChatProTab.gatewayStatusShouldExpand(
            state: .error,
            isGatewayUsable: false,
            isManuallyExpanded: false))
        #expect(ChatProTab.gatewayStatusShouldExpand(
            state: .disconnected,
            isGatewayUsable: false,
            isManuallyExpanded: false))
    }

    @Test func `chat agent badge rejects placeholder question mark`() {
        #expect(AgentIdentityPresentation.badge(avatarText: " 🦞 ", displayName: "Agent Smith") == "🦞")
        #expect(AgentIdentityPresentation.badge(avatarText: "?", displayName: "Agent Smith") == "AS")
        #expect(AgentIdentityPresentation.badge(avatarText: "   ", displayName: "Agent Smith") == "AS")
        #expect(AgentIdentityPresentation.badge(avatarText: nil, displayName: "Agent Smith") == "AS")
    }

    @Test func `pinned attachment displays its captured gateway owner`() {
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: true,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-b") == .disconnected)
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: true,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-a") == .connected)
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-b") == .connected)
    }

    @Test func `chat starter prompts stay stable and actionable`() {
        #expect(ChatProTab.emptyAssistantPrompts.map(\.id) == ["summarize-status", "show-controls", "start-voice"])
        #expect(ChatProTab.emptyAssistantPrompts.allSatisfy { !$0.title.isEmpty && !$0.prompt.isEmpty })
    }
}
