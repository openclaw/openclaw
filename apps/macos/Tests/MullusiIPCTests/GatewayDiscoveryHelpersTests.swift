import Foundation
import MullusiDiscovery
import Testing
@testable import Mullusi

struct GatewayDiscoveryHelpersTests {
    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        lanHost: String? = "txt-host.local",
        tailnetDns: String? = "txt-host.ts.net",
        sshPort: Int = 22,
        gatewayPort: Int? = 18790) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: gatewayPort,
            cliPath: "/tmp/mullusi",
            stableID: UUID().uuidString,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    private func assertSSHTarget(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway,
        host: String,
        port: Int)
    {
        guard let target = GatewayDiscoveryHelpers.sshTarget(for: gateway) else {
            Issue.record("expected ssh target")
            return
        }
        let parsed = CommandResolver.parseSSHTarget(target)
        #expect(parsed?.host == host)
        #expect(parsed?.port == port)
    }

    @Test func `ssh target uses resolved service host only`() {
        let gateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18790,
            sshPort: 2201)
        self.assertSSHTarget(for: gateway, host: "resolved.example.ts.net", port: 2201)
    }

    @Test func `ssh target allows missing resolved service port`() {
        let gateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: nil,
            sshPort: 2201)
        self.assertSSHTarget(for: gateway, host: "resolved.example.ts.net", port: 2201)
    }

    @Test func `ssh target rejects txt only gateways`() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            sshPort: 2222)

        #expect(GatewayDiscoveryHelpers.sshTarget(for: gateway) == nil)
    }

    @Test func `direct url uses resolved service endpoint only`() {
        let tlsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 443)
        #expect(GatewayDiscoveryHelpers.directUrl(for: tlsGateway) == "wss://resolved.example.ts.net")

        let wsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18790)
        #expect(GatewayDiscoveryHelpers.directUrl(for: wsGateway) == "wss://resolved.example.ts.net:18790")

        let localGateway = self.makeGateway(
            serviceHost: "127.0.0.1",
            servicePort: 18790)
        #expect(GatewayDiscoveryHelpers.directUrl(for: localGateway) == "ws://127.0.0.1:18790")
    }

    @Test func `direct url rejects txt only fallback`() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            gatewayPort: 22222)

        #expect(GatewayDiscoveryHelpers.directUrl(for: gateway) == nil)
    }
}
