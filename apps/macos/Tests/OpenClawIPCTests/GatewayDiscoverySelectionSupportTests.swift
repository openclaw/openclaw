import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        tailnetDns: String? = nil,
        sshPort: Int = 22,
        stableID: String) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: nil,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: servicePort,
            cliPath: nil,
            stableID: stableID,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    @Test func `selecting tailscale serve gateway switches to direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == tailnetHost)
        }
    }

    @Test func `selecting merged tailnet gateway still switches to direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
        }
    }

    @Test func `selecting nearby lan gateway keeps ssh transport`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "nearby-gateway.local")
        }
    }
}
