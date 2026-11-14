import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ShareGatewayTransportTests {
    @Test(arguments: ["accepted", "wrong-pin", "missing-header"])
    @MainActor
    func `share uses approved TLS and required service headers`(scenario: String) async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState()
        defer { state.restore() }
        let server = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [], tls: true, requiredWebSocketHeaders: ["x-share-service": "fixture-secret"])
        defer { server.stop() }
        let config = ShareGatewayRelayConfig(
            gatewayURLString: server.url().absoluteString,
            gatewayStableID: "share-transport-fixture",
            token: "fixture-token",
            password: nil,
            sessionKey: "main",
            tlsFingerprintSHA256: scenario == "wrong-pin" ? String(repeating: "ab", count: 32) : server.fingerprint,
            customHeaders: scenario == "missing-header" ? nil : ["X-Share-Service": "fixture-secret"])
        try #require(ShareGatewayRelaySettings.saveConfig(config))
        let loaded = try #require(ShareGatewayRelaySettings.loadConfigDiscardingUnscopedDeviceAuth())
        let gateway = GatewayNodeSession()
        do {
            try await gateway.connect(
                url: server.url(),
                credentials: .init(token: loaded.token, password: loaded.password),
                connectOptions: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-ios",
                    clientMode: "node",
                    clientDisplayName: "OpenClaw Share",
                    deviceIdentityProfile: .shareExtension,
                    includeDeviceIdentity: true,
                    allowStoredDeviceAuth: false,
                    deviceAuthGatewayID: loaded.gatewayStableID),
                sessionBox: ShareGatewayRelaySettings.webSocketSessionBox(
                    tlsFingerprintSHA256: loaded.tlsFingerprintSHA256),
                extraHeadersProvider: { try ShareGatewayRelaySettings.currentCustomHeaders(for: loaded) },
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: false) })
            await gateway.disconnect()
            #expect(scenario == "accepted")
            #expect(server.roles == ["node"])
            #expect(server.requests.first?.headers["x-share-service"] == "fixture-secret")
        } catch {
            await gateway.disconnect()
            #expect(scenario != "accepted")
            #expect(server.roles.isEmpty)
            if scenario == "wrong-pin" {
                #expect(server.requests.isEmpty)
            } else {
                let request = try #require(server.requests.first)
                #expect(request.headers["x-share-service"] == nil)
            }
        }
    }

    @Test @MainActor
    func `saved transport stays in Keychain and retires on gateway switch or header revocation`() async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let gatewayID = "share-transport-\(UUID().uuidString)"
        let secret = "fixture-service-credential"
        let config = ShareGatewayRelayConfig(
            gatewayURLString: "wss://share.example.test",
            gatewayStableID: gatewayID,
            token: nil,
            password: nil,
            sessionKey: "main",
            tlsFingerprintSHA256: String(repeating: "ab", count: 32),
            customHeaders: ["X-Service": secret])
        try #require(ShareGatewayRelaySettings.saveConfig(config))
        let loaded = try #require(ShareGatewayRelaySettings.loadConfig())
        #expect(loaded == config)
        #expect(try ShareGatewayRelaySettings.currentCustomHeaders(for: loaded) == ["X-Service": secret])
        let defaults = try #require(UserDefaults(suiteName: OpenClawAppGroup.identifier))
        let metadata = try #require(defaults.data(forKey: "share.gatewayRelay.config.v1"))
        #expect(metadata.range(of: Data(secret.utf8)) == nil)
        let other = ShareGatewayRelayConfig(
            gatewayURLString: config.gatewayURLString,
            gatewayStableID: gatewayID + "-other",
            token: nil,
            password: nil,
            sessionKey: "main")
        try defaults.set(JSONEncoder().encode(other), forKey: "share.gatewayRelay.config.v1")
        let switched = try #require(ShareGatewayRelaySettings.loadConfig())
        #expect(switched.customHeaders == nil)
        #expect(switched.tlsFingerprintSHA256 == nil)
        #expect(throws: CancellationError.self) {
            try ShareGatewayRelaySettings.currentCustomHeaders(for: loaded)
        }
        try #require(ShareGatewayRelaySettings.saveConfig(config))
        #expect(GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: gatewayID))
        #expect(ShareGatewayRelaySettings.loadConfig() == nil)
        #expect(throws: CancellationError.self) {
            try ShareGatewayRelaySettings.currentCustomHeaders(for: loaded)
        }
    }
}
