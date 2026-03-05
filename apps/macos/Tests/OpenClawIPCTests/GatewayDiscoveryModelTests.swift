@testable import OpenClawDiscovery
import Testing

@Suite
@MainActor
struct GatewayDiscoveryModelTests {
    @Test func localGatewayMatchesLanHost() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: "studio.local",
            tailnetDns: nil,
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func localGatewayMatchesTailnetDns() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: "studio.tailnet.example",
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func localGatewayMatchesDisplayName() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: [],
            displayTokens: ["peter's mac studio"])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: "Peter's Mac Studio (OpenClaw)",
            serviceName: nil,
            local: local))
    }

    @Test func remoteGatewayDoesNotMatch() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: ["peter's mac studio"])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: "other.local",
            tailnetDns: "other.tailnet.example",
            displayName: "Other Mac",
            serviceName: "other-gateway",
            local: local))
    }

    @Test func localGatewayMatchesServiceName() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "studio-gateway",
            local: local))
    }

    @Test func serviceNameDoesNotFalsePositiveOnSubstringHostToken() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["steipete"],
            displayTokens: [])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipetacstudio (OpenClaw)",
            local: local))
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipete (OpenClaw)",
            local: local))
    }

    @Test func parsesGatewayTXTFields() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  studio.local  ",
            "tailnetDns": "  peters-mac-studio-1.ts.net  ",
            "sshPort": " 2222 ",
            "gatewayPort": " 18799 ",
            "cliPath": " /opt/openclaw ",
        ])
        #expect(parsed.lanHost == "studio.local")
        #expect(parsed.tailnetDns == "peters-mac-studio-1.ts.net")
        #expect(parsed.sshPort == 2222)
        #expect(parsed.gatewayPort == 18799)
        #expect(parsed.cliPath == "/opt/openclaw")
    }

    @Test func parsesGatewayTXTDefaults() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  ",
            "tailnetDns": "\n",
            "gatewayPort": "nope",
            "sshPort": "nope",
        ])
        #expect(parsed.lanHost == nil)
        #expect(parsed.tailnetDns == nil)
        #expect(parsed.sshPort == 22)
        #expect(parsed.gatewayPort == nil)
        #expect(parsed.cliPath == nil)
    }

    @Test func buildsSSHTarget() {
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 22) == "peter@studio.local")
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 2201) == "peter@studio.local:2201")
    }

    @Test func dedupeKeyPrefersResolvedEndpointAcrossSources() {
        let wideArea = GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: "gateway-host.tailnet-example.ts.net",
            servicePort: 443,
            lanHost: nil,
            tailnetDns: "gateway-host.tailnet-example.ts.net",
            sshPort: 22,
            gatewayPort: 443,
            cliPath: nil,
            stableID: "wide-area|openclaw.internal.|gateway-host",
            debugID: "wide-area",
            isLocal: false)
        let serve = GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: "gateway-host.tailnet-example.ts.net",
            servicePort: 443,
            lanHost: nil,
            tailnetDns: "gateway-host.tailnet-example.ts.net",
            sshPort: 22,
            gatewayPort: 443,
            cliPath: nil,
            stableID: "tailscale-serve|gateway-host.tailnet-example.ts.net",
            debugID: "serve",
            isLocal: false)

        #expect(GatewayDiscoveryModel.dedupeKey(for: wideArea) == GatewayDiscoveryModel.dedupeKey(for: serve))
    }

    @Test func dedupeKeyFallsBackToStableIDWithoutEndpoint() {
        let unresolved = GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: nil,
            servicePort: nil,
            lanHost: nil,
            tailnetDns: "gateway-host.tailnet-example.ts.net",
            sshPort: 22,
            gatewayPort: nil,
            cliPath: nil,
            stableID: "tailscale-serve|gateway-host.tailnet-example.ts.net",
            debugID: "serve",
            isLocal: false)

        #expect(GatewayDiscoveryModel.dedupeKey(for: unresolved) == "stable|tailscale-serve|gateway-host.tailnet-example.ts.net")
    }
}
