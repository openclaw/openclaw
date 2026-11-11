import Foundation
import Testing
@testable import OpenClawKit

struct ShareGatewayRelayPairingTests {
    @Test(.stateDirectoryIsolated)
    func `paired app prepares a separate gateway-scoped sharing credential once`() async throws {
        let gatewayID = "share-gateway-a"
        let url = try #require(URL(string: "wss://gateway.example.invalid/context"))
        let ownerSocket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "operator", "scopes": ["operator.admin"], "deviceToken": "owner-device-token",
        ])
        let shareSocket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "node", "scopes": [], "deviceToken": "share-device-token",
        ])
        let owner = GatewayNodeSession()
        try await self.connectOwner(owner, url: url, gatewayID: gatewayID, session: ownerSocket)
        let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension))
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: identity.deviceId,
            role: "node",
            token: "other-gateway-token",
            scopes: [],
            gatewayID: "share-gateway-b",
            profile: .shareExtension))

        async let preparation: Void = ShareGatewayRelaySettings.prepareDeviceAuth(
            operatorGateway: owner,
            url: url,
            gatewayStableID: gatewayID,
            sessionBox: WebSocketSessionBox(session: shareSocket))
        let ownerTask = try #require(ownerSocket.latestTask())
        await ownerTask.waitForSentRequests(method: "device.pair.setupCode", count: 1)
        let request = try #require(ownerTask.sentRequests(method: "device.pair.setupCode").first)
        let params = try #require(request["params"] as? [String: Any])
        #expect(params["bootstrapProfile"] as? String == "node")
        #expect(params["includeQr"] as? Bool == false)
        let requestID = try #require(request["id"] as? String)
        ownerTask.emitResponse(id: requestID, payload: [
            // The host must retain its paired route rather than follow a setup response's endpoint.
            "setupCode": #"{"url":"wss://other.example.invalid","bootstrapToken":"node-bootstrap"}"#,
        ])
        try await preparation

        let nodeToken = try #require(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayID,
            profile: .shareExtension))
        #expect(nodeToken.token == "share-device-token")
        #expect(nodeToken.scopes.isEmpty)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: gatewayID,
            profile: .shareExtension) == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: "share-gateway-b",
            profile: .shareExtension)?.token == "other-gateway-token")
        #expect(shareSocket.latestRequest()?.url == url)
        let auth = try #require(shareSocket.latestTask()?.latestConnectAuth())
        #expect(auth["bootstrapToken"] as? String == "node-bootstrap")
        #expect(auth["token"] == nil)
        #expect(shareSocket.latestTask()?.latestConnectDevice()?["id"] as? String == identity.deviceId)

        // An existing credential (including one revoked on the Gateway) must not trigger re-enrollment.
        try await ShareGatewayRelaySettings.prepareDeviceAuth(
            operatorGateway: owner,
            url: url,
            gatewayStableID: gatewayID,
            sessionBox: WebSocketSessionBox(session: shareSocket))
        #expect(ownerTask.sentRequestCount(method: "device.pair.setupCode") == 1)
        #expect(shareSocket.snapshotMakeCount() == 1)
        await owner.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `limited app connections do not request elevated access to enable sharing`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let socket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "operator", "scopes": ["operator.read"],
        ])
        let owner = GatewayNodeSession()
        try await self.connectOwner(owner, url: url, gatewayID: "limited-gateway", session: socket)
        try await ShareGatewayRelaySettings.prepareDeviceAuth(
            operatorGateway: owner,
            url: url,
            gatewayStableID: "limited-gateway",
            sessionBox: nil)
        #expect(socket.latestTask()?.sentRequestCount(method: "device.pair.setupCode") == 0)
        await owner.disconnect()
    }

    @Test(.stateDirectoryIsolated, arguments: [false, true])
    func `interrupted sharing setup cannot enroll or persist credentials`(cancel: Bool) async throws {
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let socket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "operator", "scopes": ["operator.admin"],
        ])
        let shareSocket = FakeGatewayWebSocketSession()
        let owner = GatewayNodeSession()
        try await self.connectOwner(owner, url: url, gatewayID: "old-gateway", session: socket)
        let preparation = Task {
            try await ShareGatewayRelaySettings.prepareDeviceAuth(
                operatorGateway: owner,
                url: url,
                gatewayStableID: "old-gateway",
                sessionBox: WebSocketSessionBox(session: shareSocket))
        }
        let task = try #require(socket.latestTask())
        await task.waitForSentRequests(method: "device.pair.setupCode", count: 1)
        if cancel {
            preparation.cancel()
            let request = try #require(task.sentRequests(method: "device.pair.setupCode").first)
            try task.emitResponse(id: #require(request["id"] as? String), payload: [
                "setupCode": #"{"url":"wss://gateway.example.invalid","bootstrapToken":"late-bootstrap"}"#,
            ])
        } else {
            await owner.disconnect()
        }
        do {
            try await preparation.value
            Issue.record("Sharing setup should fail after cancellation or disconnect")
        } catch {
            #expect(shareSocket.snapshotMakeCount() == 0)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension))
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "node",
                gatewayID: "old-gateway",
                profile: .shareExtension) == nil)
        }
        await owner.disconnect()
    }

    @Test(.stateDirectoryIsolated, arguments: ["AUTH_DEVICE_TOKEN_MISMATCH", "AUTH_TOKEN_MISMATCH"])
    func `rejected Share credentials remain stored and cannot trigger automatic reenrollment`(
        code: String) async throws
    {
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let gatewayID = "revoked-share-gateway"
        let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension))
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: identity.deviceId,
            role: "node",
            token: "revoked-share-token",
            gatewayID: gatewayID,
            profile: .shareExtension))
        let before = DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node", gatewayID: gatewayID)
        let rejectedSocket = FakeGatewayWebSocketSession(connectError: [
            "code": "UNAVAILABLE", "message": "token mismatch",
            "details": ["code": code],
        ])
        let share = GatewayNodeSession()
        do {
            try await share.connect(
                url: url,
                credentials: GatewayNodeSessionCredentials(),
                connectOptions: ShareGatewayRelaySettings.connectOptions(gatewayStableID: gatewayID),
                sessionBox: WebSocketSessionBox(session: rejectedSocket),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: false) })
            Issue.record("Revoked Share access should be rejected")
        } catch {
            #expect((error as? GatewayConnectAuthError)?.detailCode == code)
        }
        await share.disconnect()
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId, role: "node", gatewayID: gatewayID) == before)
        let ownerSocket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "operator", "scopes": ["operator.admin"],
        ])
        let owner = GatewayNodeSession()
        try await self.connectOwner(owner, url: url, gatewayID: gatewayID, session: ownerSocket)
        try await ShareGatewayRelaySettings.prepareDeviceAuth(
            operatorGateway: owner,
            url: url,
            gatewayStableID: gatewayID,
            sessionBox: WebSocketSessionBox(session: rejectedSocket))
        #expect(ownerSocket.latestTask()?.sentRequestCount(method: "device.pair.setupCode") == 0)
        #expect(rejectedSocket.snapshotMakeCount() == 1)
        await owner.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `upgrade imports existing Share identity and credential without enrolling again`() async throws {
        let gatewayID = "upgraded-share-gateway"
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let identity = DeviceIdentityStore.generateMaterial().identity
        let directory = DeviceIdentityStore.stateDirectoryURL.appendingPathComponent("identity")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let identityURL = directory.appendingPathComponent("share-device.json")
        let authURL = directory.appendingPathComponent("share-device-auth.json")
        let identityData = try JSONEncoder().encode(identity)
        // The shipped v1 auth shape, including its gateway owner and original timestamp.
        let authData = try JSONSerialization.data(withJSONObject: [
            "version": 1, "deviceId": identity.deviceId,
            "tokens": ["node": [
                "token": "existing-share-token", "role": "node", "scopes": [],
                "updatedAtMs": 100, "gatewayID": gatewayID,
            ]],
        ])
        try identityData.write(to: identityURL)
        try authData.write(to: authURL)
        let ownerSocket = FakeGatewayWebSocketSession(helloAuth: [
            "role": "operator", "scopes": ["operator.admin"],
        ])
        let owner = GatewayNodeSession()
        try await self.connectOwner(owner, url: url, gatewayID: gatewayID, session: ownerSocket)
        let shareSocket = FakeGatewayWebSocketSession()
        try await ShareGatewayRelaySettings.prepareDeviceAuth(
            operatorGateway: owner,
            url: url,
            gatewayStableID: gatewayID,
            sessionBox: WebSocketSessionBox(session: shareSocket))
        #expect(ownerSocket.latestTask()?.sentRequestCount(method: "device.pair.setupCode") == 0)
        #expect(shareSocket.snapshotMakeCount() == 0)
        #expect(DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension) == identity)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayID,
            profile: .shareExtension) == DeviceAuthEntry(
            token: "existing-share-token", role: "node", scopes: [], updatedAtMs: 100, gatewayID: gatewayID))
        let share = GatewayNodeSession()
        try await share.connect(
            url: url,
            credentials: GatewayNodeSessionCredentials(),
            connectOptions: ShareGatewayRelaySettings.connectOptions(gatewayStableID: gatewayID),
            sessionBox: WebSocketSessionBox(session: shareSocket),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: false) })
        #expect(shareSocket.latestTask()?.latestConnectAuth()?["token"] as? String == "existing-share-token")
        #expect(shareSocket.latestTask()?.latestConnectDevice()?["id"] as? String == identity.deviceId)
        #expect(try Data(contentsOf: identityURL) == identityData)
        #expect(try Data(contentsOf: authURL) == authData)
        await share.disconnect()
        await owner.disconnect()
    }

    private func connectOwner(
        _ gateway: GatewayNodeSession,
        url: URL,
        gatewayID: String,
        session: FakeGatewayWebSocketSession) async throws
    {
        try await gateway.connect(
            url: url,
            credentials: GatewayNodeSessionCredentials(),
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: ["operator.read"],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "ui",
                clientDisplayName: "Paired iPad",
                deviceAuthGatewayID: gatewayID),
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: false) })
    }
}
