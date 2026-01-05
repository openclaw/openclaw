import Testing
@testable import Clawdbot

@Suite(.serialized)
struct GatewayEndpointStoreTests {
    @Test func resolvesLocalHostFromBindModes() {
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "loopback",
            tailscaleIP: "100.64.0.10") == "127.0.0.1")
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "lan",
            tailscaleIP: "100.64.0.10") == "127.0.0.1")
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: "100.64.0.10") == "100.64.0.10")
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: nil) == "127.0.0.1")
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: "100.64.0.10") == "100.64.0.10")
        #expect(GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: nil) == "127.0.0.1")
    }

    @Test func resolvesBindModeFromEnvOrConfig() {
        let root: [String: Any] = ["gateway": ["bind": "tailnet"]]
        #expect(GatewayEndpointStore._testResolveGatewayBindMode(
            root: root,
            env: [:]) == "tailnet")
        #expect(GatewayEndpointStore._testResolveGatewayBindMode(
            root: root,
            env: ["CLAWDBOT_GATEWAY_BIND": "lan"]) == "lan")
    }
}
