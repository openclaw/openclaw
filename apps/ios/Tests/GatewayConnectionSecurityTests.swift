import Foundation
import Network
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionSecurityTests {
    private func clearTLSFingerprint(stableID: String) {
        let suite = UserDefaults(suiteName: "ai.openclaw.shared") ?? .standard
        suite.removeObject(forKey: "gateway.tls.\(stableID)")
    }

    @Test @MainActor func discoveredTLSParams_prefersStoredPinOverAdvertisedTXT() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        clearTLSFingerprint(stableID: stableID)

        GatewayTLSStore.saveFingerprint("11", stableID: stableID)

        let endpoint: NWEndpoint = .service(name: "Test", type: "_openclaw-gw._tcp", domain: "local.", interface: nil)
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Test",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "debug",
            lanHost: "evil.example.com",
            tailnetDns: "evil.example.com",
            gatewayPort: 12345,
            canvasPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: "22",
            cliPath: nil)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway, allowTOFU: true)
        #expect(params?.expectedFingerprint == "11")
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func discoveredTLSParams_doesNotTrustAdvertisedFingerprint() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        clearTLSFingerprint(stableID: stableID)

        let endpoint: NWEndpoint = .service(name: "Test", type: "_openclaw-gw._tcp", domain: "local.", interface: nil)
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Test",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "debug",
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            canvasPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: "22",
            cliPath: nil)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

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

        let endpoint: NWEndpoint = .service(name: "Test", type: "_openclaw-gw._tcp", domain: "local.", interface: nil)
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Test",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "debug",
            lanHost: "test.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            canvasPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: nil,
            cliPath: nil)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        controller._test_setGateways([gateway])
        controller._test_triggerAutoConnect()

        #expect(controller._test_didAutoConnect() == false)
    }

    @Test @MainActor func manualConnectionsForceTLSForNonLoopbackHosts() async {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

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
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        #expect(controller._test_resolveManualPort(host: "gateway.example.com", port: 0, useTLS: true) == 18789)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net.", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 18789, useTLS: true) == 18789)
    }
}
