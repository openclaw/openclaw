import Foundation
import Network
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionSecurityTests {
    @MainActor
    private func makeController() -> GatewayConnectionController {
        GatewayConnectionController(appModel: NodeAppModel(), startDiscovery: false)
    }

    private func makeDiscoveredGateway(
        stableID: String,
        lanHost: String?,
        tailnetDns: String?,
        gatewayPort: Int?,
        fingerprint: String?) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        let endpoint: NWEndpoint = .service(name: "Test", type: "_openclaw-gw._tcp", domain: "local.", interface: nil)
        return GatewayDiscoveryModel.DiscoveredGateway(
            name: "Test",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "debug",
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            gatewayPort: gatewayPort,
            canvasPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: fingerprint,
            cliPath: nil)
    }

    private func clearTLSFingerprint(stableID: String) {
        GatewayTLSStore.clearFingerprint(stableID: stableID)
    }

    @Test @MainActor func discoveredTLSParams_prefersStoredPinOverAdvertisedTXT() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        clearTLSFingerprint(stableID: stableID)

        GatewayTLSStore.saveFingerprint("11", stableID: stableID)

        let gateway = makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "evil.example.com",
            tailnetDns: "evil.example.com",
            gatewayPort: 12345,
            fingerprint: "22")
        let controller = makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway, allowTOFU: true)
        #expect(params?.expectedFingerprint == "11")
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func discoveredTLSParams_doesNotTrustAdvertisedFingerprint() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        clearTLSFingerprint(stableID: stableID)

        let gateway = makeDiscoveredGateway(
            stableID: stableID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: "22")
        let controller = makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway, allowTOFU: true)
        #expect(params?.expectedFingerprint == nil)
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func autoconnectRequiresStoredPinForDiscoveredGateways() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        clearTLSFingerprint(stableID: stableID)

        let defaults = UserDefaults.standard
        defaults.set(true, forKey: "gateway.autoconnect")
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.removeObject(forKey: "gateway.last.host")
        defaults.removeObject(forKey: "gateway.last.port")
        defaults.removeObject(forKey: "gateway.last.tls")
        defaults.removeObject(forKey: "gateway.last.stableID")
        defaults.removeObject(forKey: "gateway.last.kind")
        defaults.removeObject(forKey: "gateway.preferredStableID")
        defaults.set(stableID, forKey: "gateway.lastDiscoveredStableID")

        let gateway = makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "test.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: nil)
        let controller = makeController()
        controller._test_setGateways([gateway])
        controller._test_triggerAutoConnect()

        #expect(controller._test_didAutoConnect() == false)
    }

    @Test @MainActor func manualConnectionsForceTLSForNonLoopbackHosts() async {
        let controller = makeController()

        #expect(controller._test_resolveManualUseTLS(host: "gateway.example.com", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "openclaw.local", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "127.attacker.example", useTLS: false) == true)

        #expect(controller._test_resolveManualUseTLS(host: "localhost", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "[::1]", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::ffff:127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "0.0.0.0", useTLS: false) == false)
    }

    @Test @MainActor func manualDefaultPortUses443OnlyForTailnetTLSHosts() async {
        let controller = makeController()

        #expect(controller._test_resolveManualPort(host: "gateway.example.com", port: 0, useTLS: true) == 18789)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net.", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 18789, useTLS: true) == 18789)
    }

    @Test @MainActor func clearAllTLSFingerprints_removesStoredPins() async {
        let stableID1 = "test|\(UUID().uuidString)"
        let stableID2 = "test|\(UUID().uuidString)"
        defer { GatewayTLSStore.clearAllFingerprints() }

        GatewayTLSStore.saveFingerprint("11", stableID: stableID1)
        GatewayTLSStore.saveFingerprint("22", stableID: stableID2)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID1) == "11")
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID2) == "22")

        GatewayTLSStore.clearAllFingerprints()

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID1) == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID2) == nil)
    }
}

    // MARK: - LAN host TLS override tests (#47887)

    @Test @MainActor func localNetworkHost_rfc1918_10x() async {
        let c = makeController()
        #expect(c._test_isLocalNetworkHost("10.0.0.1"))
        #expect(c._test_isLocalNetworkHost("10.255.255.255"))
    }

    @Test @MainActor func localNetworkHost_rfc1918_172() async {
        let c = makeController()
        #expect(c._test_isLocalNetworkHost("172.16.0.1"))
        #expect(c._test_isLocalNetworkHost("172.31.255.255"))
        #expect(!c._test_isLocalNetworkHost("172.15.0.1"))   // outside range
        #expect(!c._test_isLocalNetworkHost("172.32.0.1"))   // outside range
    }

    @Test @MainActor func localNetworkHost_rfc1918_192168() async {
        let c = makeController()
        #expect(c._test_isLocalNetworkHost("192.168.1.1"))
        #expect(c._test_isLocalNetworkHost("192.168.0.1"))
    }

    @Test @MainActor func localNetworkHost_mDNS() async {
        let c = makeController()
        #expect(c._test_isLocalNetworkHost("openclaw.local"))
        #expect(c._test_isLocalNetworkHost("mymac.local"))
    }

    @Test @MainActor func localNetworkHost_tailscale() async {
        let c = makeController()
        #expect(c._test_isLocalNetworkHost("mymachine.tail1234.ts.net"))
        #expect(c._test_isLocalNetworkHost("gateway.ts.net"))
    }

    @Test @MainActor func localNetworkHost_publicHostnames_notLocal() async {
        let c = makeController()
        #expect(!c._test_isLocalNetworkHost("example.com"))
        #expect(!c._test_isLocalNetworkHost("8.8.8.8"))
        #expect(!c._test_isLocalNetworkHost("1.1.1.1"))
    }

    @Test @MainActor func manualUseTLS_lanHostDoesNotForceTLS() async {
        let c = makeController()
        // LAN hosts with useTLS=false should stay plaintext (#47887)
        #expect(!c._test_resolveManualUseTLS(host: "192.168.1.100", useTLS: false))
        #expect(!c._test_resolveManualUseTLS(host: "10.0.0.1", useTLS: false))
        #expect(!c._test_resolveManualUseTLS(host: "openclaw.local", useTLS: false))
        #expect(!c._test_resolveManualUseTLS(host: "gateway.ts.net", useTLS: false))
    }

    @Test @MainActor func manualUseTLS_publicHostForcedTLS() async {
        let c = makeController()
        // Public hosts without explicit useTLS should still require TLS
        #expect(c._test_resolveManualUseTLS(host: "my-server.example.com", useTLS: false))
    }

    @Test @MainActor func manualUseTLS_explicitTLSTrueAlwaysUseTLS() async {
        let c = makeController()
        // Explicit useTLS=true always wins regardless of host type
        #expect(c._test_resolveManualUseTLS(host: "192.168.1.1", useTLS: true))
        #expect(c._test_resolveManualUseTLS(host: "localhost", useTLS: true))
    }
