import Foundation
import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct ChatNotificationDeliveryTests {
    private let request = ChatNotificationRequest(
        notificationID: "pending-tap", gatewayDeviceId: "notification-gateway", sessionKey: "agent:main:incident")
    private let identity = #"{"deviceId":"notification-gateway","publicKey":"fixture-public-key"}"#
    private let resolved = #"{"ok":true,"key":"agent:main:incident"}"#

    @Test(arguments: ["gateway.identity.get", "sessions.resolve"])
    func `transport loss retains tap until reconnect`(method: String) async throws {
        try await self.withConnectedModel { model, server in
            let before = model.openChatRequestID
            var replies = server.rpcReplies ?? [:]
            replies[method] = [.disconnect, .payload(method == "gateway.identity.get" ? self.identity : self.resolved)]
            server.rpcReplies = replies
            let delivery = Task(priority: .userInitiated) { await model.handleChatNotification(self.request) }
            await delivery.value
            try #require(
                model.pendingChatNotification == self.request,
                "Transport loss must retain the selected tap before reconnect")
            try await TestWait.observed("notification delivered after reconnect") {
                model.openChatRequestID == before + 1
            }
            #expect(model.chatSessionKey == self.request.sessionKey)
            #expect(model.pendingChatNotification == nil)
            let requestsBeforeDuplicate = self.destinationReads(server)
            await model.handleChatNotification(self.request)
            #expect(model.openChatRequestID == before + 1)
            #expect(self.destinationReads(server) == requestsBeforeDuplicate)
            #expect(!server.rpcMethods.contains("chat.send"))
        }
    }

    @Test func `authoritative refusal consumes tap without opening or retrying`() async throws {
        try await self.withConnectedModel { model, server in
            let before = model.openChatRequestID
            var replies = server.rpcReplies ?? [:]
            replies["sessions.resolve"] = [.failure("FORBIDDEN")]
            server.rpcReplies = replies
            await model.handleChatNotification(self.request)
            #expect(server.rpcMethods.contains("sessions.resolve"))
            #expect(model.pendingChatNotification == nil)
            #expect(model.openChatRequestID == before)
            let requestsBeforeDuplicate = self.destinationReads(server)
            await model.handleChatNotification(self.request)
            #expect(self.destinationReads(server) == requestsBeforeDuplicate)
            #expect(!server.rpcMethods.contains("chat.send"))
        }
    }

    @Test(arguments: [false, true])
    func `notification focus survives retiring a saved agent during connection hydration`(
        tapDuringHydration: Bool) async throws
    {
        try await self.withConnectedModel(prepare: { model, server, stableID in
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: "retired")
            GatewaySettingsStore.saveGatewayFocusedChatSessionKey(
                stableID: stableID, sessionKey: "agent:retired:previous")
            var replies = server.rpcReplies ?? [:]
            replies["agents.list"] = [.heldPayload(
                #"{"scope":"per-sender","mainKey":"main","defaultId":"main","agents":[]}"#)]
            server.rpcReplies = replies
            if !tapDuringHydration {
                await model.handleChatNotification(self.request)
            }
        }, operation: { model, server in
            try await TestWait.state("agent roster request held") {
                server.rpcMethods.contains("agents.list")
            }
            try #require(model.selectedAgentId == "retired")
            var delivery: Task<Void, Never>?
            defer { delivery?.cancel() }
            if tapDuringHydration {
                delivery = Task { await model.handleChatNotification(self.request) }
                try await TestWait.observed("notification tap accepted during hydration") {
                    model.pendingChatNotification == self.request || model.openChatRequestID > 0
                }
            }
            server.releaseHeldRPCPayloads()
            await delivery?.value
            try await TestWait.observed("saved agent retired") { model.selectedAgentId == nil }
            try await TestWait.observed("notification navigation completed") {
                model.pendingChatNotification == nil && model.openChatRequestID > 0
            }
            #expect(
                model.chatSessionKey == self.request.sessionKey,
                "Notification focus must survive agent-roster reconciliation")
            let stableID = try #require(model.connectedGatewayID)
            #expect(GatewaySettingsStore.loadGatewayFocusedChatSessionKey(stableID: stableID) == self.request
                .sessionKey)
            #expect(model.openChatRequestID == 1)
            await model.handleChatNotification(self.request)
            #expect(model.openChatRequestID == 1)
            #expect(!server.rpcMethods.contains("chat.send"))
        })
    }

    private func destinationReads(_ server: NativeGatewayWebSocketFixture) -> Int {
        server.rpcMethods.count { $0 == "gateway.identity.get" || $0 == "sessions.resolve" }
    }

    private func withConnectedModel(
        prepare: (NodeAppModel, NativeGatewayWebSocketFixture, String) async -> Void = { _, _, _ in },
        operation: (NodeAppModel, NativeGatewayWebSocketFixture) async throws -> Void) async throws
    {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "notification-\(UUID().uuidString)")
        defer { state.restore() }
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        defer { server.stop() }
        server.acceptedOperatorScopes = ["operator.admin"]
        server.rpcReplies = [
            "gateway.identity.get": [.payload(self.identity)],
            "sessions.resolve": [.payload(self.resolved)],
        ]
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let stableID = "notification-\(UUID().uuidString)"
        let config = GatewayConnectConfig(
            url: server.url(),
            stableID: stableID,
            tls: nil,
            token: "notification-fixture-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Notification Test",
                includeDeviceIdentity: true,
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: stableID))
        do {
            await prepare(model, server, stableID)
            model.setScenePhase(.active)
            model.applyGatewayConnectConfig(config)
            try await TestWait.observed("notification operator connection") { model.isOperatorGatewayConnected }
            try await operation(model, server)
        } catch {
            model.disconnectGateway()
            await model.resetGatewaySessionsForForcedReconnect()
            throw error
        }
        model.disconnectGateway()
        await model.resetGatewaySessionsForForcedReconnect()
    }
}
