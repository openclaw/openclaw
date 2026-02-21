import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite
struct GatewayDiscoveryHelpersTests {
    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        lanHost: String? = "txt-host.local",
        tailnetDns: String? = "txt-host.ts.net",
        sshPort: Int = 22,
        gatewayPort: Int? = 18789) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: gatewayPort,
            cliPath: "/tmp/openclaw",
            stableID: UUID().uuidString,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    @Test func sshTargetUsesResolvedServiceHostOnly() {
        let gateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18789,
            sshPort: 2201)

        guard let target = GatewayDiscoveryHelpers.sshTarget(for: gateway) else {
            Issue.record("expected ssh target")
            return
        }
        let parsed = CommandResolver.parseSSHTarget(target)
        #expect(parsed?.host == "resolved.example.ts.net")
        #expect(parsed?.port == 2201)
    }

    @Test func sshTargetRejectsTxtOnlyGateways() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            sshPort: 2222)

        #expect(GatewayDiscoveryHelpers.sshTarget(for: gateway) == nil)
    }

    @Test func directUrlUsesResolvedServiceEndpointOnly() {
        let tlsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 443)
        #expect(GatewayDiscoveryHelpers.directUrl(for: tlsGateway) == "wss://resolved.example.ts.net")

        let wsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18789)
        #expect(GatewayDiscoveryHelpers.directUrl(for: wsGateway) == "wss://resolved.example.ts.net:18789")

        let localGateway = self.makeGateway(
            serviceHost: "127.0.0.1",
            servicePort: 18789)
        #expect(GatewayDiscoveryHelpers.directUrl(for: localGateway) == "ws://127.0.0.1:18789")
    }

    @Test func directUrlRejectsTxtOnlyFallback() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            gatewayPort: 22222)

        #expect(GatewayDiscoveryHelpers.directUrl(for: gateway) == nil)
    }
}
