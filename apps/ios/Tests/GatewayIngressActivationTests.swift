import Foundation
import Network
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SafariServices
import Testing
@testable import OpenClaw

extension GatewayIngressControllerTests {
    @Test(arguments: [false, true]) @MainActor
    func `pre-TLS reservation and trust acceptance retain Access sign-out authority`(ordinary: Bool) async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-reservation-\(UUID().uuidString)")
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "saved-access-owner"
        sibling.accessOrigin = fixture.application.origin
        fixture.profileRows.append(sibling)
        if ordinary {
            fixture.preauthenticatedStableIDs.insert(fixture.stableID)
        }
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }
        let ingress = fixture.controller()
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let gate = IngressTestGate()
        let fingerprint = String(repeating: "ab", count: 32)
        let controller = GatewayConnectionController(
            appModel: model, startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in
                await gate.wait()
                return .fingerprint(fingerprint)
            }, ingress: ingress)
        let connect = Task { await controller.connectManual(host: "gateway.example.test", port: 8443, useTLS: true) }
        defer {
            gate.release()
            fixture.release.continuation.finish()
            connect.cancel()
            ingress.cancelSignIn()
        }
        try await waitForIngress { gate.started }
        #expect(fixture.requests.isEmpty)
        await ingress.signOut(stableID: sibling.stableID)
        gate.release()
        #expect(await connect.value == .accepted)
        let prompt = try #require(controller.pendingTrustPrompt)
        await controller.acceptPendingTrustPrompt(prompt)
        try await waitForIngress { !controller._test_isAutoConnectSuppressed() }
        #expect(fixture.browser.presented.isEmpty)
        #expect(fixture.profileRows[0].accessOrigin == nil)
        #expect((model.activeGatewayConnectConfig != nil) == ordinary)
        #expect(model.activeGatewayConnectConfig?.ingressAuthorization == nil)
        if !ordinary {
            fixture.release.continuation.finish()
            #expect(await controller.connectManual(
                host: "gateway.example.test", port: 8443, useTLS: true, forceReconnect: true) == .accepted)
            try await waitForIngress { model.activeGatewayConnectConfig?.ingressAuthorization != nil }
            #expect(fixture.browser.presented.count == 1)
        }
    }

    @Test @MainActor
    func `sign out revokes queued handoff before its blocked reset drain completes`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-reset-reservation-\(UUID().uuidString)")
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let model = NodeAppModel()
        let release = AsyncStream<Void>.makeStream()
        let reset = Task { for await _ in release.stream {
            break
        } }
        model._test_setGatewaySessionResetTask(reset)
        defer {
            release.continuation.finish()
            model._test_setGatewaySessionResetTask(nil)
            model.disconnectGateway()
        }
        let ingress = fixture.controller(retirement: { _ in await model.waitForGatewaySessionResetIfNeeded() })
        let controller = GatewayConnectionController(
            appModel: model, startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .systemTrusted(fingerprint: String(repeating: "ab", count: 32)) },
            ingress: ingress)
        let auth = GatewayConnectionController.ManualAuthOverride.explicit(
            token: nil, bootstrapToken: "setup-placeholder", password: nil,
            targetStableID: fixture.stableID, isSetupCodeOrigin: true, suppressStoredDeviceAuth: true)
        let checkpoint = ingress.admissionCheckpoint()
        #expect(await controller.connectManual(
            host: "gateway.example.test", port: 8443, useTLS: true, authOverride: auth) == .accepted)
        #expect(fixture.requests.isEmpty)
        let signingOut = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { signingOut.cancel()
            fixture.release.continuation.finish()
            ingress.cancelSignIn()
        }
        try await waitForIngress { ingress.admissionCheckpoint() > checkpoint }
        #expect(fixture.requests.isEmpty)
        release.continuation.finish()
        await reset.value
        await signingOut.value
        try await waitForIngress { !controller._test_isAutoConnectSuppressed() }
        #expect(fixture.browser.presented.isEmpty)
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(!auth.wasHandedOff)
    }

    @Test(arguments: [false, true]) @MainActor
    func `fleet reservation survives endpoint resolution without borrowing a signed-out grant`(
        ordinary: Bool) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-fleet-reservation-\(UUID().uuidString)")
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let fixture = try IngressTestHarness()
        let siblingID = "saved-access-owner"
        for stableID in [fixture.stableID, siblingID] {
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                stableID: stableID, kind: .discovered, name: "Gateway",
                host: nil, port: nil, useTLS: true, lastConnectedAtMs: nil), activate: stableID == siblingID))
        }
        #expect(GatewaySettingsStore.saveGatewayAccessOrigin(stableID: siblingID, origin: fixture.application.origin))
        #expect(GatewaySettingsStore.setGatewayConnectionEnabled(stableID: fixture.stableID, enabled: true))
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        GatewayTLSStore.saveFingerprint(String(repeating: "ab", count: 32), stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }
        if ordinary {
            fixture.preauthenticatedStableIDs.insert(fixture.stableID)
        }
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller(useSavedProfiles: true)
        let gate = IngressTestGate()
        let discovery = GatewayDiscoveryModel()
        let discoveredGateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Background gateway",
            endpoint: .service(name: "Background", type: "_openclaw-gw._tcp", domain: "local.", interface: nil),
            stableID: fixture.stableID, debugID: "background", lanHost: nil, tailnetDns: nil,
            gatewayPort: nil, tlsEnabled: true, tlsFingerprintSha256: nil, cliPath: nil)
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: model, startDiscovery: false, discovery: discovery,
            serviceEndpointResolver: { _ in
                await gate.wait()
                return (host: "gateway.example.test", port: 8443)
            }, ingress: ingress)
        defer { gate.release()
            controller.setScenePhase(.background)
        }
        controller.setScenePhase(.active)
        discovery.gateways = [discoveredGateway]
        try await waitForIngress { controller.gateways == [discoveredGateway] }
        try await waitForIngress { gate.started }
        let reconcile = controller.operatorFleetReconcileTask
        #expect(fixture.requests.isEmpty)
        await ingress.signOut(stableID: siblingID)
        gate.release()
        await reconcile?.value
        #expect(controller.operatorFleet._test_runtimeStableIDs().contains(fixture.stableID) == ordinary)
        #expect(fixture.browser.presented.isEmpty)
        #expect(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "Cf-Access-Token") == nil })
    }

    @Test @MainActor
    func `QR setup reservation survives route choice and bootstrap reset without renewed Access authority`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-qr-reservation-\(UUID().uuidString)")
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let ingress = fixture.controller()
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let gate = IngressTestGate()
        let fingerprint = String(repeating: "ab", count: 32)
        let controller = GatewayConnectionController(
            appModel: model, startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, label in
                if label.contains("setup-route") {
                    await gate.wait()
                }
                return true
            },
            tlsFingerprintProbe: { _ in .systemTrusted(fingerprint: fingerprint) },
            persistTLSFingerprint: { _, _ in true }, ingress: ingress)
        let deadline = Int64(fixture.now.addingTimeInterval(60).timeIntervalSince1970 * 1000)
        let link = GatewayConnectDeepLink(
            host: "gateway.example.test", port: 8443, tls: true,
            tlsFingerprintSha256: fingerprint, expiresAtMs: deadline,
            bootstrapToken: "setup-placeholder", token: nil, password: nil,
            fallbackEndpoints: [.init(host: "alternate.example.test", port: 8443, tls: true)])
        let setupAttempt = GatewaySetupAttempt(admissionCheckpoint: ingress.admissionCheckpoint())
        let routeChoice = Task { await controller.selectReachableSetupLink(link) }
        defer { gate.release()
            routeChoice.cancel()
            fixture.release.continuation.finish()
            ingress.cancelSignIn()
        }
        try await waitForIngress { gate.started }
        await ingress.signOut(stableID: fixture.stableID)
        gate.release()
        let selected = await routeChoice.value
        await model.resetGatewaySessionsForTargetSwitch()
        let auth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: selected).manualAuthOverride
        #expect(await controller.connectManual(
            host: selected.host, port: selected.port, useTLS: selected.tls,
            authOverride: auth, admissionCheckpoint: setupAttempt.admissionCheckpoint) == .accepted)
        try await waitForIngress { !controller._test_isAutoConnectSuppressed() }
        #expect(selected.expiresAtMs == deadline)
        #expect(auth.expiresAtMs == deadline)
        #expect(!auth.wasHandedOff)
        #expect(fixture.browser.presented.isEmpty)
        #expect(model.activeGatewayConnectConfig == nil)
    }

    @Test(arguments: [false, true]) @MainActor
    func `background gateway attention retries its target without switching the active gateway`(
        probeFails: Bool) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-target-\(UUID().uuidString)")
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let activeID = "manual|active.example.test|443"
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: activeID,
            kind: .manual,
            name: "Active gateway",
            host: "active.example.test",
            port: 443,
            useTLS: true,
            lastConnectedAtMs: nil), activate: true))
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false, ingress: ingress)
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route,
                userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        let attention = try #require(ingress.attention)
        if probeFails {
            fixture.probeFailure = URLError(.notConnectedToInternet)
            let outcome = await controller.retryGatewayIngress(attention)
            guard case let .failed(message) = outcome else {
                Issue.record("Expected a visible settings action failure")
                return
            }
            #expect(!message.isEmpty)
            #expect(fixture.browser.presented.isEmpty)
            #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == activeID)
            #expect(model.activeGatewayConnectConfig == nil)
            return
        }
        let retry = Task { await controller.retryGatewayIngress(attention) }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        fixture.release.continuation.yield()
        #expect(await retry.value == .accepted)
        #expect(ingress.hasSession(stableID: fixture.stableID))
        #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == activeID)
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(fixture.requestRoutes.allSatisfy { $0.stableID == fixture.stableID })
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test(arguments: ["renew", "stop", "switch"]) @MainActor
    func `common recovery restores the desired active profile sharing background attention`(
        action: String) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let instanceID = "access-shared-recovery-\(UUID().uuidString)"
        let state = try TemporaryOpenClawState(instanceID: instanceID)
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let fixture = try IngressTestHarness()
        let activeEntry = try #require(fixture.profileRows.first)
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(activeEntry, activate: true))
        let backgroundID = "discovered-background-access"
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: backgroundID,
            kind: .discovered,
            name: "Background gateway",
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil)))
        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: "gateway-token",
            bootstrapToken: nil,
            password: "gateway-password",
            gatewayStableID: fixture.stableID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID))
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        let fingerprint = String(repeating: "ab", count: 32)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let ingress = fixture.controller(useSavedProfiles: true) { origin in
            await model.retireGatewayIngress(for: origin)
        }
        var resetEntered = 0
        var resetCompleted = 0
        let controller = GatewayConnectionController(
            appModel: model,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint(fingerprint) },
            forceReconnectReset: { model in
                resetEntered += 1
                await model.resetGatewaySessionsForForcedReconnect()
                resetCompleted += 1
            },
            ingress: ingress)
        @MainActor func handoffDiagnostic(expectedGeneration: UInt64) -> Comment {
            let problem = model.lastGatewayProblem
            var message = problem?.message ?? "none"
            for credential in [
                "gateway-token",
                "gateway-password",
                fixture.nextSession.authorizationHeader(for: fixture.route.url, now: fixture.now),
            ]
                .compactMap(\.self).filter({ !$0.isEmpty })
            {
                message = message.replacingOccurrences(of: credential, with: "<redacted>")
            }
            return """
            \(action) handoff: expectedGeneration=\(expectedGeneration), currentGeneration=\(model.gatewayConnectGeneration), \
            activeStableID=\(model.activeGatewayConnectConfig?.stableID ?? "nil"), \
            resetInFlight=\(model.hasGatewaySessionResetInFlight), resetEntered=\(resetEntered), resetCompleted=\(resetCompleted), \
            suppressed=\(controller._test_isAutoConnectSuppressed()), pendingProbes=\(fixture.pendingProbes), \
            problemKind=\(problem?.kind.rawValue ?? "none"), problemMessage=\(message.prefix(160))
            """
        }
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let old = try #require(admitted)
        let activeProbes = AsyncStream<Void>.makeStream()
        fixture.probeStableID = fixture.stableID
        fixture.probeGate = activeProbes.stream
        defer { activeProbes.continuation.finish() }
        try model.applyGatewayConnectConfig(fixture.config(old))
        try await waitForIngress { fixture.pendingProbes == 2 }
        fixture.revoked = true
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: .init(url: fixture.route.url, stableID: backgroundID, tls: nil), userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(ingress.attention?.stableID == backgroundID)
        #expect(fixture.pendingProbes == 0)
        fixture.probeGate = nil
        activeProbes.continuation.finish()
        fixture.revoked = false
        let retry = Task { await controller.retryGatewayConnection() }
        defer { fixture.release.continuation.finish()
            retry.cancel()
        }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        let otherID = "manual|localhost|18789"
        if action == "stop" {
            model.disconnectGateway()
        } else if action == "switch" {
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                stableID: otherID,
                kind: .manual,
                name: "Other gateway",
                host: "localhost",
                port: 18789,
                useTLS: false,
                lastConnectedAtMs: nil)))
            #expect(await controller.switchToGateway(stableID: otherID) == .accepted)
            let switchGeneration = model.gatewayConnectGeneration
            try await waitForIngress(handoffDiagnostic(expectedGeneration: switchGeneration)) {
                model.activeGatewayConnectConfig?.stableID == otherID
            }
        }
        fixture.release.continuation.yield()
        let outcome = await retry.value
        if action == "renew" {
            #expect(outcome == .accepted)
            let retryGeneration = model.gatewayConnectGeneration
            try await waitForIngress(handoffDiagnostic(expectedGeneration: retryGeneration)) {
                model.activeGatewayConnectConfig?.stableID == fixture.stableID
            }
            let config = try #require(model.activeGatewayConnectConfig)
            #expect(config.ingressAuthorization?.revision != old.revision)
            #expect(config.token == "gateway-token")
            #expect(config.password == "gateway-password")
            #expect(config.bootstrapToken == nil)
        } else {
            #expect(outcome == .superseded)
            #expect(model.activeGatewayConnectConfig?.stableID == (action == "switch" ? otherID : nil))
        }
        #expect(fixture.browser.presented.count == 1)
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test @MainActor
    func `automatic discovered admission never presents a browser despite suppression ownership`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-discovery-\(UUID().uuidString)")
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }
        let fingerprint = String(repeating: "ab", count: 32)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: fixture.stableID)
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(true, forKey: "gateway.autoconnect")
        let discovery = GatewayDiscoveryModel()
        discovery.gateways = [.init(
            name: "Protected gateway",
            endpoint: .service(name: "Protected", type: "_openclaw-gw._tcp", domain: "local.", interface: nil),
            stableID: fixture.stableID,
            debugID: "protected",
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: nil,
            cliPath: nil)]
        let ingress = fixture.controller()
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: model,
            startDiscovery: false,
            discovery: discovery,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint(fingerprint) },
            serviceEndpointResolver: { _ in (host: "gateway.example.test", port: 8443) },
            ingress: ingress)
        try await waitForIngress { ingress.attention != nil }
        #expect(fixture.browser.presented.isEmpty)
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(model.lastGatewayProblem?.kind == .externalAuthorizationRequired)
        _ = controller.cancelPendingConnectionAttempts()
    }

    @Test @MainActor
    func `QR expiry during browser sign-in preserves Access and rejects the first Gateway handoff`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let instanceID = "access-qr-\(UUID().uuidString)"
        let state = try TemporaryOpenClawState(instanceID: instanceID)
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let fingerprint = String(repeating: "ab", count: 32)
        let controller = GatewayConnectionController(
            appModel: model,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint(fingerprint) },
            persistTLSFingerprint: { _, _ in true },
            ingress: ingress,
            now: { fixture.now })
        let expiry = fixture.now.addingTimeInterval(30)
        let auth = GatewayConnectionController.ManualAuthOverride.explicit(
            token: "gateway-token",
            bootstrapToken: "one-use-bootstrap",
            password: "gateway-password",
            targetStableID: fixture.stableID,
            tlsFingerprintSha256: fingerprint,
            expiresAtMs: Int64(expiry.timeIntervalSince1970 * 1000),
            isSetupCodeOrigin: true,
            suppressStoredDeviceAuth: true)
        // The real form persists before controller admission. Its saved bootstrap
        // must not outlive the receipt while unrelated Gateway credentials survive.
        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: auth.token,
            bootstrapToken: auth.bootstrapToken,
            password: auth.password,
            gatewayStableID: fixture.stableID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID))
        await controller.connectManual(
            host: "gateway.example.test", port: 8443, useTLS: true, authOverride: auth)
        try await waitForIngress { fixture.browser.presented.count == 1 }
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(!auth.wasHandedOff)
        fixture.now = expiry
        fixture.release.continuation.yield()
        try await waitForIngress { model.lastGatewayProblem?.kind == .bootstrapTokenInvalid }
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(!auth.wasHandedOff)
        #expect(ingress.hasSession(stableID: fixture.stableID))
        let stored = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: fixture.stableID)
        #expect(stored.bootstrapToken == nil)
        #expect(stored.token == "gateway-token")
        #expect(stored.password == "gateway-password")
        let retry = GatewayConnectionController.ManualAuthOverride.explicit(
            token: nil,
            bootstrapToken: "fresh-bootstrap",
            password: nil,
            targetStableID: fixture.stableID,
            tlsFingerprintSha256: fingerprint,
            expiresAtMs: Int64(expiry.addingTimeInterval(600).timeIntervalSince1970 * 1000),
            isSetupCodeOrigin: true,
            suppressStoredDeviceAuth: true)
        await controller.connectManual(
            host: "gateway.example.test", port: 8443, useTLS: true, authOverride: retry)
        try await waitForIngress { model.activeGatewayConnectConfig != nil }
        #expect(retry.wasHandedOff)
        #expect(model.activeGatewayConnectConfig?.bootstrapToken == "fresh-bootstrap")
        #expect(model.activeGatewayConnectConfig?.ingressAuthorization != nil)
        #expect(fixture.browser.presented.count == 1)
        _ = controller.cancelPendingConnectionAttempts()
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test @MainActor
    func `capability refresh retains ingress and certificate rotation reacquires TLS`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-refresh-\(UUID().uuidString)")
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(admitted)
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: model,
            startDiscovery: false,
            persistTLSFingerprint: { _, _ in true },
            ingress: ingress)
        let oldTLS = GatewayTLSParams(
            required: true, expectedFingerprint: "old-certificate", allowTOFU: false, storeKey: fixture.stableID)
        try model.applyGatewayConnectConfig(fixture.config(authorization, tls: oldTLS))
        await controller.refreshActiveGatewayRegistrationFromSettingsAsync()
        #expect(model.activeGatewayConnectConfig?.ingressAuthorization?.revision == authorization.revision)
        #expect(model.activeGatewayConnectConfig?.token == "gateway-token")
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.example.test",
                storeKey: fixture.stableID,
                expectedFingerprint: "old-certificate",
                observedFingerprint: "new-certificate",
                systemTrustOk: true),
            context: "connect to gateway")
        let problem = try #require(GatewayConnectionProblemMapper.map(error: error))
        let didTrust = await controller.trustRotatedGatewayCertificate(from: problem)
        #expect(didTrust)
        let refreshed = try #require(model.activeGatewayConnectConfig)
        #expect(refreshed.tls?.expectedFingerprint == "new-certificate")
        #expect(refreshed.ingressAuthorization?.revision == authorization.revision)
        #expect(fixture.requestRoutes.contains { $0.tls?.expectedFingerprint == "new-certificate" })
        let headers = try await refreshed.ingressAuthorization?.headers(refreshed.url)
        #expect(headers?["Cf-Access-Token"] != nil)
        #expect(fixture.requestRoutes.last?.tls?.expectedFingerprint == "new-certificate")
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test @MainActor
    func `retirement drains real node operator and fleet admission without losing Gateway credentials`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let instanceID = "access-drain-\(UUID().uuidString)"
        let state = try TemporaryOpenClawState(instanceID: instanceID)
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let model = NodeAppModel()
        let fleet = GatewayOperatorFleet()
        defer { model.disconnectGateway()
            fleet.stopAll()
        }
        let ingress = fixture.controller { origin in
            await fleet.retire(origin: origin)
            await model.retireGatewayIngress(for: origin)
        }
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(admitted)
        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: "gateway-token",
            bootstrapToken: nil,
            password: "gateway-password",
            gatewayStableID: fixture.stableID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID))
        let gate = AsyncStream<Void>.makeStream()
        fixture.probeGate = gate.stream
        try model.applyGatewayConnectConfig(fixture.config(authorization))
        let generation = model.gatewayConnectGeneration
        let backgroundID = "manual|background-route.example.test|8443"
        try fleet.reconcile(
            desiredStableIDs: [backgroundID],
            configs: [fixture.config(authorization, stableID: backgroundID)])
        try await waitForIngress { fixture.pendingProbes == 3 }
        try await ingress.forget(origin: fixture.application.origin)
        try await waitForIngress { fixture.pendingProbes == 0 }
        #expect(model.activeGatewayConnectConfig == nil)
        #expect(model.gatewayConnectGeneration == generation)
        #expect(!model.hasGatewaySessionResetInFlight)
        let stored = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: fixture.stableID)
        #expect(stored.token == "gateway-token")
        #expect(stored.password == "gateway-password")
        #expect(fixture.browser.presented.isEmpty)
        gate.continuation.finish()
    }

    @Test @MainActor
    func `managed media uses the admitted token and rejects a retired download`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(admitted)
        let config = try fixture.config(authorization)
        let started = AsyncStream<Void>.makeStream()
        let loader = IOSMediaArtifactLoader(connectionProvider: {
            .init(config: config, gatewayID: config.effectiveStableID, customHeaders: [:])
        }, requestFactory: { _, _ in
            { request in
                #expect(request.value(forHTTPHeaderField: "Cf-Access-Token") != nil)
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                #expect(request.url?.host == "gateway.example.test")
                #expect(request.url?.port == 8443)
                started.continuation.yield()
                try await Task.sleep(for: .seconds(300))
                throw URLError(.timedOut)
            }
        })
        let response = ArtifactsDownloadResult(
            artifact: ArtifactSummary(
                id: "artifact",
                type: "media",
                title: "Attachment",
                mimetype: "video/mp4",
                sizebytes: 3,
                download: ["mode": AnyCodable("url")]),
            url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=ticket")
        let download = Task { try await loader.load(
            response: response,
            kind: .video,
            expectedGatewayID: config.effectiveStableID) }
        for await _ in started.stream {
            break
        }
        try await ingress.forget(origin: fixture.application.origin)
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.retirements == 1)
    }

    @Test(arguments: [false, true]) @MainActor
    func `background sign-in and sign-out preserve an ordinary active profile`(savedAssociation: Bool) async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-ordinary-owner-\(UUID().uuidString)")
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        fixture.preauthenticatedStableIDs.insert(fixture.stableID)
        var active = try #require(fixture.profileRows.first)
        if savedAssociation {
            active.accessOrigin = fixture.application.origin
        }
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(active, activate: true))
        let backgroundID = "discovered-managed-background"
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: backgroundID,
            kind: .discovered,
            name: "Managed gateway",
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil)))
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        let ingress = fixture.controller(useSavedProfiles: true) { origin in
            await model.retireGatewayIngress(for: origin)
        }
        let ordinary = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(ordinary == nil)
        try model.applyGatewayConnectConfig(fixture.config(ordinary))
        let generation = model.gatewayConnectGeneration
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false, ingress: ingress)
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: .init(url: fixture.route.url, stableID: backgroundID, tls: nil), userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        let attention = try #require(ingress.attention)
        let retry = Task { await controller.retryGatewayIngress(attention) }
        defer { fixture.release.continuation.finish()
            retry.cancel()
        }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        fixture.release.continuation.finish()
        #expect(await retry.value == .accepted)
        #expect(model.gatewayConnectGeneration == generation)
        #expect(model.activeGatewayConnectConfig?.stableID == fixture.stableID)
        #expect(model.activeGatewayConnectConfig?.ingressAuthorization == nil)
        #expect(fixture.retirements == 1)
        #expect(fixture.requests.first?.value(forHTTPHeaderField: "X-Existing-Ingress") == "preserved")
        await ingress.signOut(stableID: backgroundID)
        #expect(fixture.retirements == 2)
        #expect(model.activeGatewayConnectConfig?.stableID == fixture.stableID)
        #expect(model.gatewayConnectGeneration == generation)
    }

    @Test(arguments: ["fresh", "suspended", "failed cleanup"]) @MainActor
    func `pending Forget excludes fresh and suspended fleet admissions`(scenario: String) async throws {
        let capturedBeforeForget = scenario == "suspended"
        let cleanupSucceeds = scenario != "failed cleanup"
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "access-forget-fleet-\(UUID().uuidString)")
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
        let fixture = try IngressTestHarness()
        let siblingID = "discovered-sibling"
        for stableID in [fixture.stableID, siblingID] {
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                stableID: stableID,
                kind: .discovered,
                name: stableID,
                host: nil,
                port: nil,
                useTLS: true,
                lastConnectedAtMs: nil), activate: stableID == siblingID))
        }
        #expect(GatewaySettingsStore.setGatewayConnectionEnabled(stableID: fixture.stableID, enabled: true))
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        GatewayTLSStore.saveFingerprint(String(repeating: "ab", count: 32), stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller(useSavedProfiles: true)
        let first = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let firstAuthorization = try #require(first)
        let sibling = try await ingress.prepare(
            route: .init(url: fixture.route.url, stableID: siblingID, tls: nil), userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let siblingAuthorization = try #require(sibling)
        let mediaGate = IngressTestGate()
        let resolverGate = IngressTestGate()
        let download = Task {
            try await firstAuthorization.load(URLRequest(url: fixture.route.url)) { _ in
                await mediaGate.wait()
                throw CancellationError()
            }
        }
        defer { mediaGate.release()
            resolverGate.release()
            download.cancel()
        }
        try await waitForIngress { mediaGate.started }
        let discovery = GatewayDiscoveryModel()
        let discoveredGateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Forgotten gateway",
            endpoint: .service(name: "Forgotten", type: "_openclaw-gw._tcp", domain: "local.", interface: nil),
            stableID: fixture.stableID,
            debugID: "forgotten",
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: nil,
            cliPath: nil)
        let model = NodeAppModel()
        if !cleanupSucceeds {
            model.testStageChatOfflineDataRemovalHandler = { _ in false }
        }
        defer { model.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: model,
            startDiscovery: false,
            discovery: discovery,
            serviceEndpointResolver: { _ in
                if capturedBeforeForget {
                    await resolverGate.wait()
                }
                return (host: "gateway.example.test", port: 8443)
            }, ingress: ingress)
        defer { controller.setScenePhase(.background) }
        var captured: Task<Void, Never>?
        if capturedBeforeForget {
            controller.setScenePhase(.active)
            discovery.gateways = [discoveredGateway]
            try await waitForIngress { controller.gateways == [discoveredGateway] }
            try await waitForIngress { resolverGate.started }
            captured = controller.operatorFleetReconcileTask
        }
        let forgotten = Task { await controller.forgetGateway(stableID: fixture.stableID) }
        defer { forgotten.cancel() }
        try await waitForIngress { !firstAuthorization.isCurrent() }
        #expect(controller.hasPendingForgetCleanup(stableID: fixture.stableID))
        let priorRequests = fixture.requestRoutes.filter { $0.stableID == fixture.stableID }.count
        controller.setScenePhase(.active)
        controller.restartDiscovery()
        discovery.gateways = [discoveredGateway]
        try await waitForIngress { controller.gateways == [discoveredGateway] }
        await controller.operatorFleetReconcileTask?.value
        resolverGate.release()
        await captured?.value
        #expect(fixture.requestRoutes.filter { $0.stableID == fixture.stableID }.count == priorRequests)
        #expect(controller.operatorFleet._test_runtimeStableIDs().isEmpty)
        #expect(siblingAuthorization.isCurrent())
        mediaGate.release()
        #expect(await forgotten.value == cleanupSucceeds)
        await #expect(throws: CancellationError.self) { try await download.value }
        if !cleanupSucceeds {
            await controller.operatorFleetReconcileTask?.value
            #expect(!controller.hasPendingForgetCleanup(stableID: fixture.stableID))
            #expect(GatewaySettingsStore.loadGatewayRegistry().entries.contains { $0.stableID == fixture.stableID })
            #expect(controller.operatorFleet._test_runtimeStableIDs().contains(fixture.stableID))
            #expect(siblingAuthorization.isCurrent())
            try await ingress.forget(origin: fixture.application.origin)
            return
        }
        #expect(!GatewaySettingsStore.loadGatewayRegistry().entries.contains { $0.stableID == fixture.stableID })
        #expect(!firstAuthorization.isCurrent())
        #expect(siblingAuthorization.isCurrent())
        controller.restartDiscovery()
        discovery.gateways = [discoveredGateway]
        try await waitForIngress { controller.gateways == [discoveredGateway] }
        await controller.operatorFleetReconcileTask?.value
        #expect(controller.operatorFleet._test_runtimeStableIDs().isEmpty)
        #expect(fixture.requestRoutes.filter { $0.stableID == fixture.stableID }.count == priorRequests)
        try await ingress.forget(origin: fixture.application.origin)
    }
}
