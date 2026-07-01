import Foundation
import Network
import OpenClawKit
import Testing
import os
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
        self.clearTLSFingerprint(stableID: stableID)

        GatewayTLSStore.saveFingerprint("11", stableID: stableID)

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "evil.example.com",
            tailnetDns: "evil.example.com",
            gatewayPort: 12345,
            fingerprint: "22")
        let controller = self.makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway)
        #expect(params?.expectedFingerprint == "11")
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func discoveredTLSParams_doesNotTrustAdvertisedFingerprint() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: "22")
        let controller = self.makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway)
        #expect(params?.expectedFingerprint == nil)
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func autoconnectRequiresStoredPinForDiscoveredGateways() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

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

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "test.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: nil)
        let controller = self.makeController()
        controller._test_setGateways([gateway])
        controller._test_triggerAutoConnect()

        #expect(controller._test_didAutoConnect() == false)
    }

    @Test @MainActor func manualConnectionsForceTLSForNonLoopbackHosts() async {
        let controller = self.makeController()

        #expect(controller._test_resolveManualUseTLS(host: "gateway.example.com", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "127.attacker.example", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "gateway.ts.net", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "100.64.0.9", useTLS: false) == true)

        #expect(controller._test_resolveManualUseTLS(host: "localhost", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "[::1]", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::ffff:127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "0.0.0.0", useTLS: false) == false)
    }

    @Test @MainActor func manualConnectionsAllowPrivateLanPlaintext() async {
        let controller = self.makeController()

        #expect(controller._test_resolveManualUseTLS(host: "openclaw.local", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "192.168.1.20", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "10.0.0.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "172.16.1.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "169.254.1.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "fd00::1", useTLS: false) == false)
    }

    @Test @MainActor func manualDefaultPortUses443OnlyForTailnetTLSHosts() async {
        let controller = self.makeController()

        #expect(controller._test_resolveManualPort(host: "gateway.example.com", port: 0, useTLS: true) == 18789)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net.", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 18789, useTLS: true) == 18789)
    }

    @Test @MainActor func manualFirstUseTLSProbeShowsTrustPromptAfterFingerprintCapture() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(controller.pendingTrustPrompt?.fingerprintSha256 == "abc123")
        #expect(controller.pendingTrustPrompt?.host == host)
        #expect(controller.pendingTrustPrompt?.port == port)
        #expect(appModel.gatewayStatusText == "Verify gateway TLS fingerprint")
    }

    @Test @MainActor func manualFirstUseTLSProbeSkipsTLSWhenTCPIsUnreachable() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        let tlsProbeCalls = OSAllocatedUnfairLock(initialState: 0)
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in false },
            tlsFingerprintProbe: { _ in
                tlsProbeCalls.withLock { $0 += 1 }
                return .fingerprint("abc123")
            })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(tlsProbeCalls.withLock { $0 } == 0)
        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.gatewayStatusText == "Can't reach gateway at \(host):\(port). Check Tailscale or LAN.")
    }

    @Test @MainActor func manualFirstUseTLSProbeReportsHandshakeTimeoutWithoutTrustPrompt() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let staleProblem = GatewayConnectionProblem(
            kind: .pairingRequired,
            owner: .gateway,
            title: "Pairing required",
            message: "Approve an old request.",
            requestId: "stale-request",
            retryable: true,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(staleProblem)
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .failure(.tlsHandshakeTimeout) })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.lastGatewayProblem == nil)
        #expect(appModel.gatewayStatusText.contains("TLS fingerprint verification timed out"))
        #expect(appModel.gatewayStatusText.contains("\(host):\(port)"))
    }

    @Test @MainActor func discoveredFirstUseTLSProbeFailureClearsStaleTrustPrompt() async {
        let staleHost = "stale-\(UUID().uuidString).example.com"
        let stalePort = 18789
        let staleStableID = "manual|\(staleHost.lowercased())|\(stalePort)"
        let discoveredStableID = "discovered|\(UUID().uuidString)"
        let discoveredHost = "gateway.tailnet.ts.net"
        let discoveredPort = 443
        defer {
            clearTLSFingerprint(stableID: staleStableID)
            clearTLSFingerprint(stableID: discoveredStableID)
        }
        self.clearTLSFingerprint(stableID: staleStableID)
        self.clearTLSFingerprint(stableID: discoveredStableID)

        let tlsResults = OSAllocatedUnfairLock(initialState: [
            GatewayTLSFingerprintProbeResult.fingerprint("abc123"),
            .failure(.tlsHandshakeTimeout),
        ])
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in tlsResults.withLock { $0.removeFirst() } },
            serviceEndpointResolver: { _ in (host: discoveredHost, port: discoveredPort) })

        await controller.connectManual(host: staleHost, port: stalePort, useTLS: true)
        #expect(controller.pendingTrustPrompt?.fingerprintSha256 == "abc123")

        let gateway = self.makeDiscoveredGateway(
            stableID: discoveredStableID,
            lanHost: nil,
            tailnetDns: discoveredHost,
            gatewayPort: discoveredPort,
            fingerprint: nil)
        let message = await controller.connectWithDiagnostics(gateway)

        #expect(controller.pendingTrustPrompt == nil)
        #expect(message?.contains("TLS fingerprint verification timed out") == true)
        #expect(message?.contains("\(discoveredHost):\(discoveredPort)") == true)
        #expect(appModel.gatewayStatusText == message)
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

    @Test func trustedPinMismatchCanBeRecoveredByReplacingStoredPin() {
        let stableID = "test|\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.tailnet.ts.net",
                storeKey: stableID,
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: true),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.canTrustRotatedCertificate == true)
        #expect(problem?.tlsStoreKey == stableID)
        #expect(problem?.tlsExpectedFingerprint == "old")
        #expect(problem?.tlsObservedFingerprint == "new")

        #expect(GatewayTLSStore.replaceFingerprint(problem?.tlsObservedFingerprint ?? "", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func untrustedPinMismatchCannotBeRecoveredInApp() {
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.tailnet.ts.net",
                storeKey: "gateway",
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: false),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.canTrustRotatedCertificate == false)
    }
}
