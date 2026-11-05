import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension GatewayEndpointStoreTests {
    @MainActor
    private func withLocalGatewayConfig(
        _ data: Data,
        operation: (URL, GatewayEndpointStore) async throws -> Void) async throws
    {
        let configURL = URL(fileURLWithPath: TestIsolation.tempConfigPath())
        try data.write(to: configURL)
        defer { try? FileManager.default.removeItem(at: configURL) }
        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configURL.path,
                "OPENCLAW_GATEWAY_PORT": "18789",
                "OPENCLAW_GATEWAY_BIND": nil,
                "OPENCLAW_GATEWAY_TLS": nil,
                "OPENCLAW_GATEWAY_TOKEN": nil,
                "OPENCLAW_GATEWAY_PASSWORD": nil,
            ],
            defaults: [connectionModeKey: "local"])
        {
            let state = AppState(preview: true)
            let store = self.makeStore(sourceSnapshot: {
                try await GatewayEndpointStore._testLiveSourceSnapshot(state: state, beforeConfigRead: {})
            })
            try await operation(configURL, store)
        }
    }

    @MainActor
    @Test(arguments: ["::1", "my host", "[::1]", ""], [true, false])
    func `invalid custom bind configuration is unavailable and recovers`(
        host: String,
        invalidAtStartup: Bool) async throws
    {
        // The base revision traps here; keep each expected crash out of the suite process.
        await #expect(processExitsWith: .success) { [host, invalidAtStartup] in
            try await GatewayEndpointStoreTests().checkInvalidCustomBindHost(
                host: host, invalidAtStartup: invalidAtStartup)
        }
    }

    @MainActor
    private func checkInvalidCustomBindHost(host: String, invalidAtStartup: Bool) async throws {
        let invalid = try JSONSerialization.data(withJSONObject: [
            "gateway": ["mode": "local", "bind": "custom", "customBindHost": host],
        ])
        let valid = Data(#"{"gateway":{"mode":"local","bind":"custom","customBindHost":"127.0.0.2"}}"#.utf8)
        let expectedURL = try #require(URL(string: "ws://127.0.0.2:18789"))
        try await self.withLocalGatewayConfig(invalidAtStartup ? invalid : valid) { configURL, store in
            if !invalidAtStartup {
                guard case let .ready(.local, url, _, _, _) = await store.currentState() else {
                    Issue.record("Expected the configured custom endpoint at initialization")
                    return
                }
                #expect(url == expectedURL)
                _ = try await store.requireEndpoint()
                try invalid.write(to: configURL)
                await store.refresh()
            }
            guard case let .unavailable(.local, reason, _) = await store.currentState() else {
                Issue.record("Expected invalid custom binding to make the local endpoint unavailable")
                return
            }
            #expect(reason.contains("gateway.customBindHost"))
            do {
                _ = try await store.requireEndpoint()
                Issue.record("Invalid binding must not return a fallback or previously ready endpoint")
            } catch {
                #expect(error.localizedDescription == reason)
            }
            try #expect(Data(contentsOf: configURL) == invalid)

            try valid.write(to: configURL)
            await store.refresh()
            let recovered = try await store.requireEndpoint()
            #expect(recovered.config.url == expectedURL)
            #expect(await store.currentState() == .ready(
                mode: .local, url: expectedURL, token: nil, password: nil, routeRevision: store.routeRevision))
            try #expect(Data(contentsOf: configURL) == valid)
        }
    }

    @MainActor
    @Test(arguments: ["loopback", "lan", "auto", "custom"])
    func `valid local bind endpoints are unchanged through initialization and refresh`(bind: String) async throws {
        let config = try JSONSerialization.data(withJSONObject: [
            "gateway": [
                "mode": "local", "bind": bind, "customBindHost": "192.168.1.10", "tls": ["enabled": true],
            ],
        ])
        let host = bind == "custom" ? "192.168.1.10" : "127.0.0.1"
        let expectedURL = try #require(URL(string: "wss://\(host):18789"))
        try await self.withLocalGatewayConfig(config) { configURL, store in
            guard case let .ready(.local, url, _, _, _) = await store.currentState() else {
                Issue.record("Expected a ready local endpoint at initialization")
                return
            }
            #expect(url == expectedURL)
            await store.refresh()
            try #expect(await store.requireEndpoint().config.url == expectedURL)
            try #expect(Data(contentsOf: configURL) == config)
        }
    }
}
