import AppKit
import Foundation
import JavaScriptCore
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

struct DashboardGatewayCatalogTests {
    @Test(arguments: [AppState.ConnectionMode.local, .remote, .unconfigured], [false, true])
    func `hosted local Gateway is a separate nonpromotable remote companion`(
        mode: AppState.ConnectionMode,
        hosting: Bool) throws
    {
        let url = try #require(URL(string: "wss://saved.example"))
        let entries = DashboardGatewayCatalog.entries(
            mode: mode,
            primaryRemoteURL: nil,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: "primary.example",
            profiles: [.init(profile: .init(id: "saved", name: "Saved", url: url), canPromote: true)],
            primaryHealth: .ok,
            hostsLocalGateway: hosting,
            localHealth: .error)
        if mode == .remote, hosting {
            #expect(entries.map(\.id) == ["primary", "local", "profile:saved"])
            #expect(entries[1] == DashboardGatewayEntry(
                id: "local", name: "This Mac", kind: "local", isPrimary: false, canPromote: false, health: .error))
            #expect(DashboardGatewayTarget(bridgeID: entries[1].id) == .local)
            #expect(DashboardGatewayTarget.local.bridgeID == "local")
        } else {
            #expect(!entries.contains { $0.id == "local" })
        }
    }

    @Test func `primary remote label uses the SSH host or resolved direct endpoint`() {
        let cases: [(AppState.RemoteTransport, String?, String?, String?)] = [
            (.ssh, "user@studio.local", "127.0.0.1:18789", "studio.local"),
            (.ssh, "studio.local:2222", "127.0.0.1:18789", "studio.local"),
            (.ssh, " user@studio.local:2222 \n", nil, "studio.local"),
            (.ssh, " \n", "resolved.example", "resolved.example"),
            (.ssh, nil, nil, nil),
            (.direct, "user@studio.local", "direct.example:443", "direct.example:443"),
        ]
        for (transport, sshTarget, resolvedHostLabel, expected) in cases {
            #expect(DashboardGatewayCatalog.primaryRemoteHostLabel(
                transport: transport,
                sshTarget: sshTarget,
                resolvedHostLabel: resolvedHostLabel) == expected)
        }
    }

    @Test(arguments: [false, true])
    func `unconfigured catalog omits primary and retains saved gateways`(hasProfiles: Bool) throws {
        let url = try #require(URL(string: "wss://studio.example"))
        let entries = DashboardGatewayCatalog.entries(
            mode: .unconfigured,
            primaryRemoteURL: url,
            resolvedRemoteURL: url,
            resolvedRemoteHostLabel: "studio.example",
            profiles: hasProfiles ? [.init(
                profile: .init(id: "studio", name: "Studio", url: url),
                canPromote: true)] : [],
            primaryHealth: .unknown)

        #expect(entries.map(\.id) == (hasProfiles ? ["profile:studio"] : []))
        #expect(!entries.contains { $0.isPrimary })
        if hasProfiles {
            #expect(entries.first?.name == "Studio")
            #expect(entries.first?.canPromote == true)
        }
    }

    @Test(arguments: [false, true])
    func `catalog keeps browser authority separate from the primary route`(usesBrowserIdentity: Bool) throws {
        let primaryURL = try #require(URL(string: "wss://studio.example/control"))
        let duplicate = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "studio", name: "My Studio", url: primaryURL),
            canPromote: !usesBrowserIdentity,
            usesBrowserIdentity: usesBrowserIdentity)
        let other = try MacGatewayCatalogProfile(
            profile: MacGatewayProfile(
                id: "backup",
                name: "Backup",
                url: #require(URL(string: "wss://backup.example"))),
            canPromote: false)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: primaryURL,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: "studio.example:443",
            profiles: [duplicate, other],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == (usesBrowserIdentity
                ? ["primary", "profile:studio", "profile:backup"] : ["primary", "profile:backup"]))
        #expect(entries[0].name == (usesBrowserIdentity ? "studio.example:443" : "My Studio"))
        #expect(entries[0].kind == "remote")
        #expect(entries[0].health == .ok)
        #expect(!entries[0].canPromote)
        #expect(!entries[1].canPromote)
        #expect(entries[1].health == .unknown)
    }

    @Test func `catalog deduplicates profile matching resolved SSH endpoint`() throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let profile = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "loopback", name: "127.0.0.1", url: tunnelURL),
            canPromote: true)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: nil,
            resolvedRemoteURL: tunnelURL,
            resolvedRemoteHostLabel: "127.0.0.1:18789",
            profiles: [profile],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == ["primary"])
        #expect(entries[0].name == "127.0.0.1")
    }

    @Test func `catalog deduplicates configured SSH endpoint before resolution`() throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let profile = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "loopback", name: "127.0.0.1", url: tunnelURL),
            canPromote: true)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: tunnelURL,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: nil,
            profiles: [profile],
            primaryHealth: .unknown)

        #expect(entries.map(\.id) == ["primary"])
        #expect(entries[0].name == "127.0.0.1")
    }

    @Test @MainActor func `catalog maps live control health`() {
        #expect(DashboardGatewayCatalog.primaryHealth(for: .connected) == .ok)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .disconnected) == .unknown)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .connecting) == .unknown)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .degraded("offline")) == .error)
    }

    @Test func `local catalog does not deduplicate a retained remote profile`() throws {
        let url = try #require(URL(string: "wss://studio.example"))
        let entries = DashboardGatewayCatalog.entries(
            mode: .local,
            primaryRemoteURL: url,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: "127.0.0.1:18789",
            profiles: [.init(
                profile: .init(id: "studio", name: "Studio", url: url),
                canPromote: true)],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == ["primary", "profile:studio"])
        #expect(entries[0].name == "Local Gateway")
    }
}

@MainActor
struct DashboardGatewaysBridgeTests {
    @Test func `gateway script publishes metadata and emits its change event`() throws {
        let snapshot = DashboardGatewaySnapshot(
            gateways: [.init(
                id: "primary",
                name: "Local Gateway",
                kind: "local",
                isPrimary: true,
                canPromote: false,
                health: .ok)],
            currentId: "primary")
        let script = DashboardWindowController.nativeGatewaysScriptSource(snapshot: snapshot, dispatch: true)
        let context = try #require(JSContext())
        context.evaluateScript("""
        var window = globalThis;
        var publishedEvent;
        class CustomEvent { constructor(type) { this.type = type; } }
        window.dispatchEvent = event => { publishedEvent = event.type; };
        """)
        context.evaluateScript(script)
        #expect(context.exception == nil)
        #expect(context.objectForKeyedSubscript("publishedEvent").toString() == "openclaw:native-gateways-changed")
        let value = try #require(context.objectForKeyedSubscript("__OPENCLAW_NATIVE_GATEWAYS__").toDictionary())
        #expect(value["currentId"] as? String == "primary")
        let entries = try #require(value["gateways"] as? [[String: Any]])
        #expect(entries.count == 1)
        #expect(entries[0]["name"] as? String == "Local Gateway")
        #expect(entries[0]["token"] == nil)
        #expect(entries[0]["password"] == nil)
    }

    @Test func `dashboard controller retains profile TLS policy`() throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "a", count: 64),
            allowTOFU: false,
            storeKey: "profile:studio")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            tlsParams: params,
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }

        #expect(controller.tlsParams == params)
        #expect(ControlUIDocumentHost.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 0,
            dashboardURL: url))
        #expect(ControlUIDocumentHost.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 443,
            dashboardURL: url))
        #expect(!ControlUIDocumentHost.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 8443,
            dashboardURL: url))
        #expect(!ControlUIDocumentHost.isExpectedTLSAuthority(
            host: "other.example",
            port: 443,
            dashboardURL: url))
    }

    @Test func `media capture trust requires the dashboard origin`() throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        #expect(ControlUIDocumentHost.isTrustedMediaCaptureOrigin(
            protocol: "https",
            host: "gateway.example",
            port: 443,
            dashboardURL: url))
        #expect(!ControlUIDocumentHost.isTrustedMediaCaptureOrigin(
            protocol: "https",
            host: "other.example",
            port: 443,
            dashboardURL: url))
        #expect(!ControlUIDocumentHost.isTrustedMediaCaptureOrigin(
            protocol: "http",
            host: "gateway.example",
            port: 80,
            dashboardURL: url))
    }
}

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardManagerGatewayTargetTests {
    @Test func `background configuration keeps the gateway profile registry cold`() async {
        var catalogReads = 0
        let manager = DashboardManager._testMake(
            observeGatewayChanges: true,
            automaticGatewayProfileRefreshEnabled: false,
            gatewayEntriesProvider: {
                catalogReads += 1
                return []
            })

        manager.configure(updater: DashboardGatewayTestUpdater())
        NotificationCenter.default.post(name: MacGatewayProfileStore.didChangeNotification, object: nil)
        for _ in 0..<20 {
            await Task.yield()
        }

        #expect(catalogReads == 0)
        #expect(manager._testGatewayRefreshObserverCount() == 0)
    }

    @Test func `interactive configuration retains the gateway profile refresh`() async {
        var catalogReads = 0
        let manager = DashboardManager._testMake(
            gatewayEntriesProvider: {
                catalogReads += 1
                return []
            })

        manager.configure(updater: DashboardGatewayTestUpdater())
        for _ in 0..<20 where catalogReads == 0 {
            await Task.yield()
        }

        #expect(catalogReads == 1)
    }

    @Test func `primary window configuration retains resolved TLS policy`() async throws {
        try await TestIsolation.withEnvValues([:]) {
            let state = AppStateStore.shared
            let originalMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = originalMode }
            let url = try #require(URL(string: "wss://studio.example:443/"))
            let params = GatewayTLSParams(
                required: true,
                expectedFingerprint: String(repeating: "a", count: 64),
                allowTOFU: false,
                storeKey: "primary")
            let manager = DashboardManager._testMake(primaryEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: "primary-token", password: nil),
                    tls: GatewayTLSRoute(params: params, allowsTrustedPinReplacement: false),
                    routeAuthority: nil)
            })

            #expect(try await manager._testWindowTLSParams(for: .primary) == params)
        }
    }

    @Test func `primary endpoint subscription does not mutate profile targeted main window`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let studio = "studio-\(UUID().uuidString)"
        let url = server.url("/#token=current")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "current",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let entries = DashboardGatewayTestEntries.withProfiles([studio])
        let manager = DashboardManager._testMake(gatewayEntriesProvider: { entries })
        manager._testSetController(controller)
        manager._testSetMainTarget(.profile(studio))

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: replacementServer.websocketURL(""),
            token: "replacement",
            password: nil,
            routeRevision: 2))

        #expect(manager._testController() === controller)
        #expect(controller.currentURL == url)

        try await manager.show()
        #expect(manager._testController() === controller)
        #expect(manager._testMainTarget() == .profile(studio))
        #expect(!manager.showConfiguredWindowIfPossible())
    }

    @Test func `opening primary creates isolated auxiliary window`() async throws {
        try await TestIsolation.withEnvValues([:]) {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let replacementServer = try await DashboardHTTPFixture.start()
            defer { replacementServer.stop() }
            let studio = "studio-\(UUID().uuidString)"
            let dataStore = WKWebsiteDataStore.nonPersistent()
            let state = AppStateStore.shared
            let originalMode = state.connectionMode
            state.connectionMode = .local
            defer { state.connectionMode = originalMode }
            let url = server.url("/#token=current")
            let controller = DashboardWindowController(
                url: url,
                auth: DashboardWindowAuth(
                    gatewayUrl: server.websocketURL("/").absoluteString,
                    token: "current",
                    password: nil),
                websiteDataStore: dataStore,
                windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
                requestBrowserProfileImportOffer: { _ in false })
            defer { controller.closeDashboard() }
            let frame = NSRect(x: 180, y: 180, width: 960, height: 720)
            controller.window?.setFrame(frame, display: false)
            controller.show()
            // CI display bounds clamp window frames during show, so preserve the post-clamp source frame.
            let sourceFrame = try #require(controller.window).frame
            let entries = DashboardGatewayTestEntries.withProfiles([studio])
            let manager = DashboardManager._testMake(
                websiteDataStore: dataStore,
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: replacementServer.websocketURL(), token: "primary-token", password: nil),
                        routeAuthority: nil)
                },
                profileEndpointProvider: { profileID in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: profileID, password: nil),
                        routeAuthority: nil)
                },
                gatewayEntriesProvider: { entries })
            manager.configure(updater: DashboardGatewayTestUpdater())
            manager._testSetController(controller)
            manager._testSetMainTarget(.profile(studio))
            defer { manager.close() }

            await manager._testOpenWindow(for: .primary)

            #expect(manager._testController() === controller)
            #expect(manager._testMainTarget() == .profile(studio))
            #expect(controller.window?.frame == sourceFrame)
            let auxiliaryWindows = manager._testAuxiliaryWindows()
            #expect(auxiliaryWindows.count == 1)
            let auxiliary = try #require(auxiliaryWindows.first)
            #expect(auxiliary.target == .primary)
            #expect(auxiliary.controller !== controller)
            #expect(auxiliary.controller.window !== controller.window)
            #expect(auxiliary.controller.window?.frameAutosaveName != controller.window?.frameAutosaveName)
            let primaryAutosaveName = try #require(auxiliary.controller.window?.frameAutosaveName)
            #expect(primaryAutosaveName.hasPrefix("OpenClawDashboardWindow-Test-"))
            #expect(!auxiliary.controller._testUpdateBridgeAvailable)
            #expect(auxiliary.controller.currentURL == replacementServer.url("/"))
            #expect(auxiliary.controller.webView.configuration.websiteDataStore === dataStore)
            #expect(!auxiliary.controller.webView.configuration.websiteDataStore.isPersistent)
            try auxiliary.controller.nativeBrowser.open(
                tabId: "mac-auxiliary",
                url: server.url("/reader/auxiliary"),
                sessionKey: "")
            #expect(try #require(auxiliary.controller.nativeBrowser.webView(for: "mac-auxiliary"))
                .configuration.websiteDataStore === dataStore)

            let auxiliaryWindow = auxiliary.controller.window
            await manager.handleEndpointState(.connecting(mode: .remote, detail: "Switching Gateway"))
            let reconnecting = try #require(manager._testAuxiliaryWindows().first?.controller)
            #expect(reconnecting.currentURL == URL(string: "about:blank"))
            #expect(!reconnecting.auth.hasCredential)
            #expect(reconnecting.window === auxiliaryWindow)
            #expect(manager._testController() === controller)

            await manager.handleEndpointState(.ready(
                mode: .remote,
                url: replacementServer.websocketURL(),
                token: "rotated-primary-token",
                password: nil,
                routeRevision: 2))
            let recovered = try #require(manager._testAuxiliaryWindows().first?.controller)
            #expect(recovered.auth.token == "rotated-primary-token")
            #expect(recovered.window === auxiliaryWindow)
            #expect(!recovered._testUpdateBridgeAvailable)
            #expect(manager._testController() === controller)

            _ = await manager.switchTarget(.profile(studio), in: recovered)?.value
            let replacement = try #require(manager._testAuxiliaryWindows().first?.controller)
            #expect(replacement !== auxiliary.controller)
            #expect(replacement.window === auxiliaryWindow)
            let profileAutosaveName = try #require(replacement.window?.frameAutosaveName)
            #expect(profileAutosaveName.hasPrefix("\(primaryAutosaveName)-\(studio)-"))
            #expect(replacement.webView.configuration.websiteDataStore === dataStore)
            #expect(!replacement.webView.configuration.websiteDataStore.isPersistent)
            try replacement.nativeBrowser.open(
                tabId: "mac-replacement",
                url: server.url("/reader/replacement"),
                sessionKey: "")
            #expect(try #require(replacement.nativeBrowser.webView(for: "mac-replacement"))
                .configuration.websiteDataStore === replacement.webView.configuration.websiteDataStore)
        }
    }

    @Test func `concurrent switches keep the latest selection for one window`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let currentServer = try await DashboardHTTPFixture.start()
        defer { currentServer.stop() }
        let firstID = "first-\(UUID().uuidString)"
        let secondID = "second-\(UUID().uuidString)"
        let firstURL = replacementServer.websocketURL()
        let secondURL = currentServer.websocketURL()
        let gate = DashboardWindowOwnershipPresentationGate()
        let sourceURL = server.url("/#token=current")
        let controller = DashboardWindowController(
            url: sourceURL,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "current",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let originalWindow = try #require(controller.window)
        let entries = DashboardGatewayTestEntries.withProfiles([firstID, secondID])
        let manager = DashboardManager._testMake(
            profileEndpointProvider: { profileID in
                if profileID == firstID {
                    await gate.waitForRelease()
                }
                let url = profileID == firstID ? firstURL : secondURL
                return GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: profileID, password: nil),
                    routeAuthority: nil)
            },
            gatewayEntriesProvider: { entries })
        manager._testSetController(controller)
        defer { manager.close() }

        let first = Task { @MainActor in
            _ = await manager.switchTarget(.profile(firstID), in: controller)?.value
        }
        await gate.waitUntilRequested()
        let second = Task { @MainActor in
            _ = await manager.switchTarget(.profile(secondID), in: controller)?.value
        }
        await second.value
        await gate.release()
        await first.value

        #expect(manager._testMainTarget() == .profile(secondID))
        #expect(manager._testController()?.currentURL.port == Int(currentServer.port))
        #expect(manager._testController()?.window === originalWindow)
    }

    @Test func `promotion keeps other saved profile windows on their physical gateway`() async throws {
        let savedServer = try await DashboardHTTPFixture.start()
        let primaryServer = try await DashboardHTTPFixture.start(
            html: """
            <html><body><script>
            window.commandEvents = [];
            window.addEventListener('openclaw:native-toggle-search', event => {
              event.preventDefault(); window.commandEvents.push('palette');
            });
            </script></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer {
            savedServer.stop()
            primaryServer.stop()
        }
        let saved = GatewayConnectionEndpointSource(url: savedServer.websocketURL(), token: "saved-b")
        let primary = GatewayConnectionEndpointSource(url: primaryServer.websocketURL(), token: "primary-a")
        let profileGate = DashboardWindowOwnershipPresentationGate()
        let profile = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "saved-b", name: "Saved B", url: savedServer.websocketURL()),
            canPromote: true)
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in primary.snapshot() },
            profileEndpointProvider: { _ in
                let endpoint = saved.snapshot()
                guard endpoint.config.token != "removed" else { throw MacGatewayProfileError.profileNotFound }
                if endpoint.config.password != nil { await profileGate.waitForRelease() }
                return endpoint
            },
            gatewayEntriesProvider: {
                DashboardGatewayCatalog.entries(
                    mode: .remote,
                    primaryRemoteURL: primary.snapshot().config.url,
                    resolvedRemoteURL: nil,
                    resolvedRemoteHostLabel: nil,
                    profiles: saved.snapshot().config.token == "removed" ? [] : [MacGatewayCatalogProfile(
                        profile: profile.profile,
                        canPromote: saved.snapshot().config.token != nil)],
                    primaryHealth: .ok)
            })
        defer { manager.close() }
        await manager._testOpenWindow(for: .profile("saved-b"))
        await manager._testOpenWindow(for: .profile("saved-b"))
        let originals = manager._testAuxiliaryWindows()
        let promoted = try #require(originals.first?.controller)
        let promotedWindow = try #require(promoted.window)
        let fixedWindow = try #require(originals.last?.controller.window)
        #expect(promotedWindow !== fixedWindow)

        primary.setEndpoint(saved.snapshot())
        _ = await manager.switchTarget(.primary, in: promoted)?.value
        #expect(manager.gatewayEntries.contains { $0.id == "profile:saved-b" })
        saved.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: savedServer.websocketURL(), token: nil, password: "password-only"), routeAuthority: nil))
        manager.configure(updater: DashboardGatewayTestUpdater())
        await profileGate.waitUntilRequested()
        #expect(manager.gatewayEntries.contains { $0.id == "profile:saved-b" })
        await profileGate.release()
        try await TestWait.state("saved profile credentials") {
            manager.gatewayEntries.first(where: { $0.id == "profile:saved-b" })?.canPromote == false
        }
        #expect(manager.gatewayEntries.first { $0.id == "profile:saved-b" }?.canPromote == false)
        saved.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: savedServer.websocketURL(), token: "saved-b", password: nil), routeAuthority: nil))
        primary.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: primaryServer.websocketURL(), token: "primary-c", password: nil), routeAuthority: nil))
        await manager.handleEndpointState(.ready(
            mode: .remote, url: primaryServer.websocketURL(), token: "primary-c", password: nil, routeRevision: 2))

        let windows = manager._testAuxiliaryWindows()
        let following = try #require(windows.first { $0.controller.window === promotedWindow })
        let fixed = try #require(windows.first { $0.controller.window === fixedWindow })
        #expect(following.target == .primary)
        #expect(following.controller.auth.token == "primary-c")
        #expect(fixed.target == .profile("saved-b"))
        #expect(fixed.controller.auth.token == "saved-b")
        #expect(fixed.controller.currentURL.port == Int(savedServer.port))

        fixed.controller.webView(fixed.controller.webView, didCommit: nil)
        fixed.controller.dispatchNativeCommand(.commandPalette)
        #expect(fixed.controller._testPendingNativeCommands == [.commandPalette])
        saved.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: savedServer.websocketURL(), token: "removed", password: nil), routeAuthority: nil))
        manager.configure(updater: DashboardGatewayTestUpdater())
        try await TestWait.state("removed profile windows") {
            !manager._testAuxiliaryWindows().contains(where: { $0.target == .profile("saved-b") })
        }
        #expect(!manager.gatewayEntries.contains { $0.id == "profile:saved-b" })
        #expect(manager._testAuxiliaryWindows().allSatisfy { $0.target == .primary })
        #expect(!fixedWindow.isVisible)
        #expect(fixed.controller._testPendingNativeCommands.isEmpty)
        #expect(!fixed.controller.canDeliverNativeCommands)
    }

    @Test func `picker selection survives primary document replacement`() async throws {
        try await self.withConfiguredPrimary {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let gate = DashboardWindowOwnershipPresentationGate()
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
                },
                profileEndpointProvider: { profileID in
                    await gate.waitForRelease()
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: profileID, password: nil), routeAuthority: nil)
                },
                gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
            defer { manager.close() }
            try await manager.show()
            let source = try #require(manager._testController())
            let window = try #require(source.window)
            let selection = Task { _ = await manager.switchTarget(.profile("secondary"), in: source)?.value }
            await gate.waitUntilRequested()

            await manager.handleEndpointState(.connecting(mode: .remote, detail: "Reconnecting"))
            #expect(manager._testController() !== source)
            await gate.release()
            await selection.value

            #expect(manager._testMainTarget() == .profile("secondary"))
            #expect(manager._testController()?.auth.token == "secondary")
            #expect(manager._testController()?.window === window)
        }
    }

    @Test func `picker resolves the current primary after suspended authentication`() async throws {
        try await self.withConfiguredPrimary {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let gate = DashboardWindowOwnershipPresentationGate(released: true)
            let source = GatewayConnectionEndpointSource(url: server.websocketURL(), token: "before")
            let manager = DashboardManager._testMake(
                authTokenProvider: { config in
                    if config.token == "before" { await gate.waitForRelease() }
                    return config.token
                },
                primaryEndpointProvider: { _ in source.snapshot() },
                profileEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil)
                },
                gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
            defer { manager.close() }
            try await manager.show()
            await manager._testOpenWindow(for: .profile("secondary"))
            let secondary = try #require(manager._testAuxiliaryWindows().first?.controller)
            let window = try #require(secondary.window)
            await gate.hold()
            let selection = Task { _ = await manager.switchTarget(.primary, in: secondary)?.value }
            await gate.waitUntilRequested()
            source.setEndpoint(GatewayConnection.EndpointSnapshot(
                config: (url: server.websocketURL(), token: "after", password: nil), routeAuthority: nil))
            await manager.handleEndpointState(.ready(
                mode: .remote, url: server.websocketURL(), token: "after", password: nil, routeRevision: 2))
            await gate.release()
            await selection.value

            let selected = try #require(manager._testAuxiliaryWindows().first)
            #expect(selected.target == .primary)
            #expect(selected.controller.auth.token == "after")
            #expect(selected.controller.window === window)
        }
    }

    @Test func `saved credential changes refresh every existing profile document`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let source = GatewayConnectionEndpointSource(url: server.websocketURL(), token: "before")
        let manager = DashboardManager._testMake(
            observeGatewayChanges: true,
            profileEndpointProvider: { _ in source.snapshot() },
            gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
        defer { manager.close() }
        await manager._testOpenWindow(for: .profile("secondary"))
        await manager._testOpenWindow(for: .profile("secondary"))
        let windows = manager._testAuxiliaryWindows().compactMap(\.controller.window)
        #expect(windows.count == 2)
        source.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: server.websocketURL(), token: "after", password: nil), routeAuthority: nil))

        NotificationCenter.default.post(name: MacGatewayProfileStore.didChangeNotification, object: nil)
        try await TestWait.state("refreshed profile credentials") {
            !manager._testAuxiliaryWindows().contains(where: { $0.controller.auth.token != "after" })
        }

        let refreshed = manager._testAuxiliaryWindows()
        #expect(refreshed.count == 2)
        #expect(refreshed.allSatisfy { $0.controller.auth.token == "after" })
        #expect(refreshed.allSatisfy { instance in windows.contains { $0 === instance.controller.window } })
        for instance in refreshed {
            let bootstrap = try await dashboardNativeAuthSnapshot(instance.controller)
            #expect(bootstrap["nativeConnectAuth"] as? Bool == true)
            #expect(bootstrap["token"] == nil)
            #expect(bootstrap["password"] == nil)
        }
    }

    @Test(arguments: ["recover", "switch-away-and-back", "command-during-refresh", "reselect-current"])
    func `failed secondary command recovery retains its window and command order`(_ scenario: String) async throws {
        try await self.withConfiguredPrimary {
            let server = try await DashboardHTTPFixture.start(
                html: """
                <html><body><script>
                window.commandEvents = [];
                window.addEventListener('openclaw:native-new-session', () => window.commandEvents.push('new-session'));
                window.addEventListener('openclaw:native-toggle-search', event => {
                  event.preventDefault(); window.commandEvents.push('palette');
                });
                </script></body></html>
                """,
                contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
            defer { server.stop() }
            let gate = DashboardWindowOwnershipPresentationGate()
            let catalogGate = DashboardWindowOwnershipPresentationGate(released: true)
            let saved = GatewayConnectionEndpointSource(url: server.websocketURL(), token: "secondary")
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
                },
                profileEndpointProvider: { _ in
                    let endpoint = saved.snapshot()
                    if endpoint.config.token == "suspended" { await gate.waitForRelease() }
                    return endpoint
                },
                gatewayEntriesProvider: {
                    await catalogGate.waitForRelease()
                    return DashboardGatewayTestEntries.withProfiles(["secondary"])
                })
            defer { manager.close() }
            try await manager.show()
            let primary = try #require(manager._testController())
            await manager._testOpenWindow(for: .profile("secondary"))
            let secondary = try #require(manager._testAuxiliaryWindows().first?.controller)
            let window = try #require(secondary.window)
            if scenario == "command-during-refresh" { await catalogGate.hold() }
            secondary.showFailure(title: "Unavailable", message: "Synthetic connection failure")
            saved.setEndpoint(GatewayConnection.EndpointSnapshot(
                config: (url: server.websocketURL(), token: "suspended", password: nil), routeAuthority: nil))
            manager.dispatchNativeCommand(.newSession)
            manager.dispatchNativeCommand(.commandPalette)
            manager.dispatchNativeCommand(.commandPalette)
            await gate.waitUntilRequested()
            saved.setEndpoint(GatewayConnection.EndpointSnapshot(
                config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil))
            if scenario == "switch-away-and-back" {
                for target in [DashboardGatewayTarget.primary, .profile("secondary")] {
                    let current = try #require(window.windowController as? DashboardWindowController)
                    manager.handleGatewayRequest(.select(target), from: current)
                    try await TestWait.state("selected recovery gateway") {
                        manager._testAuxiliaryWindows().first?.target == target
                    }
                    #expect(manager._testAuxiliaryWindows().first?.target == target)
                }
            } else if scenario == "reselect-current" {
                secondary.show()
                manager.openOrFocusDashboard(for: .profile("secondary"))
            }
            await gate.release()
            if scenario == "command-during-refresh" {
                await catalogGate.waitUntilRequested()
                let recovered = try #require(window.windowController as? DashboardWindowController)
                try await DashboardTestWait.document(recovered, "recovered gateway document")
                #expect(recovered.canDeliverNativeCommands)
                recovered.show()
                manager.dispatchNativeCommand(.commandPalette)
                await catalogGate.release()
            }

            var primaryCommands: [String] = []
            var secondaryCommands: [String] = []
            let expectedCount = scenario == "command-during-refresh" ? 4 : 3
            @MainActor func readCommands() async -> Int {
                primaryCommands = await (
                    try? primary.webView.evaluateJavaScript("window.commandEvents") as? [String]) ??
                    []
                if let recovered = window.windowController as? DashboardWindowController {
                    await secondaryCommands =
                        (try? recovered.webView.evaluateJavaScript("window.commandEvents") as? [String]) ?? []
                }
                return primaryCommands.count + secondaryCommands.count
            }
            if scenario == "switch-away-and-back" {
                // Absence window: no command may reach either document.
                let deadline = ContinuousClock.now + .seconds(5)
                while await readCommands() < expectedCount, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
            } else {
                try await TestWait.state("recovered command delivery") {
                    await readCommands() >= expectedCount
                }
            }

            let expected: [String] = switch scenario {
            case "switch-away-and-back": []
            case "command-during-refresh": ["new-session", "palette", "palette", "palette"]
            default: ["new-session", "palette", "palette"]
            }
            #expect(primaryCommands.isEmpty)
            #expect(secondaryCommands == expected)
            #expect(manager._testController() === primary)
            #expect(manager._testAuxiliaryWindows().first?.controller.window === window)
            #expect((window.windowController as? DashboardWindowController)?.canDeliverNativeCommands == true)
        }
    }

    @Test func `native commands stay in the frontmost gateway window`() async throws {
        try await self.withConfiguredPrimary {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let entries = DashboardGatewayTestEntries.withProfiles(["secondary"])
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil),
                        routeAuthority: nil)
                },
                profileEndpointProvider: { profileID in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: profileID, password: nil),
                        routeAuthority: nil)
                },
                gatewayEntriesProvider: { entries })
            defer { manager.close() }
            try await manager.show()
            let primary = try #require(manager._testController())
            await manager._testOpenWindow(for: .profile("secondary"))
            let secondary = try #require(manager._testAuxiliaryWindows().first?.controller)
            for controller in [primary, secondary] {
                // Profile preparation can precede WebKit's loading flag. Install
                // listeners only after the fixture document replaces the blank page.
                try await DashboardTestWait.document(controller, "gateway command document") {
                    controller.webView.url?.port == Int(server.port)
                }
                try #require(controller.webView.url?.port == Int(server.port))
                try #require(!controller.webView.isLoading)
                #expect(controller.canDeliverNativeCommands)
                _ = try await controller.webView.evaluateJavaScript("""
                window.commandEvents = [];
                window.addEventListener('openclaw:native-new-session', () => window.commandEvents.push('new-session'));
                window.addEventListener('openclaw:native-toggle-search', event => {
                  event.preventDefault(); window.commandEvents.push('palette');
                });
                """)
            }
            secondary.show()
            #expect(manager.frontmostDashboardTarget == .profile("secondary"))
            manager.dispatchNativeCommand(.newSession)
            manager.dispatchNativeCommand(.commandPalette)
            let primaryCommands = try await primary.webView.evaluateJavaScript("window.commandEvents") as? [String]
            let secondaryCommands = try await secondary.webView.evaluateJavaScript("window.commandEvents") as? [String]
            #expect(primaryCommands == [])
            #expect(secondaryCommands == ["new-session", "palette"])
        }
    }

    @Test func `closing the manager retires a pending gateway window open`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let gate = DashboardWindowOwnershipPresentationGate()
        let entries = DashboardGatewayTestEntries.withProfiles(["secondary"])
        let manager = DashboardManager._testMake(
            profileEndpointProvider: { profileID in
                await gate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: profileID, password: nil),
                    routeAuthority: nil)
            },
            gatewayEntriesProvider: { entries })
        defer { manager.close() }
        let open = Task { await manager._testOpenWindow(for: .profile("secondary")) }
        await gate.waitUntilRequested()
        manager.close()
        await gate.release()
        await open.value
        #expect(manager._testAuxiliaryWindows().isEmpty)
        #expect(manager.frontmostDashboardTarget == nil)
    }

    @Test(arguments: ["bridge", "open-menu", "new-window-menu", "closed-source", "replaced-source"])
    func `window requests cannot outlive their admitting owner`(_ entry: String) async throws {
        try await self.withConfiguredPrimary {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
                },
                profileEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil)
                },
                gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
            defer { manager.close() }
            try await manager.show()
            let source = try #require(manager._testController())
            let target = DashboardGatewayTarget.profile("secondary")
            switch entry {
            case "bridge": manager.handleGatewayRequest(.openWindow(target), from: source)
            case "open-menu": manager.openOrFocusDashboard(for: target)
            case "closed-source":
                source.closeDashboard()
                manager.handleGatewayRequest(.openWindow(target), from: source)
            case "replaced-source":
                _ = await manager.switchTarget(.profile("replacement"), in: source)?.value
                manager.handleGatewayRequest(.openWindow(target), from: source)
            default:
                source.closeDashboard()
                manager.openNewDashboardWindow(for: target)
            }
            if entry != "closed-source", entry != "replaced-source" { manager.close() }
            let deadline = ContinuousClock.now + .seconds(1)
            while manager._testAuxiliaryWindows().isEmpty, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(manager._testAuxiliaryWindows().isEmpty)
            #expect(manager._testController()?.isWindowOpen == (entry == "replaced-source"))
            if entry == "replaced-source" { #expect(manager._testMainTarget() == .profile("replacement")) }
        }
    }

    @Test func `main menu opens or focuses a gateway and can open another independent window`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let studio = "studio"
        let entries = DashboardGatewayTestEntries.withProfiles([studio])
        let profileEndpoint: @Sendable (String) async throws -> GatewayConnection.EndpointSnapshot = { profileID in
            GatewayConnection.EndpointSnapshot(
                config: (url: server.websocketURL(""), token: profileID, password: nil),
                routeAuthority: nil)
        }
        let manager = DashboardManager._testMake(
            profileEndpointProvider: profileEndpoint,
            gatewayEntriesProvider: { entries })
        defer { manager.close() }

        manager.openOrFocusDashboard(for: .profile(studio))
        try await TestWait.state("frontmost gateway window") {
            manager.frontmostDashboardTarget == .profile(studio)
        }

        let windows = manager._testAuxiliaryWindows()
        #expect(windows.count == 1)
        #expect(windows.first?.target == .profile(studio))
        #expect(windows.first?.controller.isWindowOpen == true)
        #expect(manager.frontmostDashboardTarget == .profile(studio))
        let window = try #require(windows.first?.controller.window)
        let autosaveName = window.frameAutosaveName
        #expect(autosaveName.hasPrefix("OpenClawDashboardWindow-Test-"))
        #expect(autosaveName.hasSuffix("-\(studio)"))

        await manager.openOrFocusDashboard(for: .profile(studio)).value
        #expect(manager._testAuxiliaryWindows().count == 1)
        #expect(manager._testAuxiliaryWindows().first?.controller.window === window)
        #expect(manager.frontmostDashboardTarget == .profile(studio))

        manager.openNewDashboardWindow(for: .profile(studio))
        try await TestWait.state("second gateway window") {
            manager._testAuxiliaryWindows().count >= 2
        }
        let newWindows = manager._testAuxiliaryWindows()
        #expect(newWindows.count == 2)
        #expect(newWindows.allSatisfy { $0.target == .profile(studio) && $0.controller.isWindowOpen })
        let newWindow = try #require(newWindows.first { $0.controller.window !== window }?.controller.window)
        #expect(newWindow.frameAutosaveName != autosaveName)
        #expect(newWindow.frameAutosaveName.hasPrefix("OpenClawDashboardWindow-Test-"))

        let otherManager = DashboardManager._testMake(
            profileEndpointProvider: profileEndpoint,
            gatewayEntriesProvider: { entries })
        defer { otherManager.close() }
        await otherManager._testOpenWindow(for: .profile(studio))
        let otherAutosaveName = try #require(otherManager._testAuxiliaryWindows().first?.controller.window?
            .frameAutosaveName)
        #expect(otherAutosaveName.hasPrefix("OpenClawDashboardWindow-Test-"))
        #expect(otherAutosaveName.hasSuffix("-\(studio)"))
        #expect(otherAutosaveName != autosaveName)
    }

    @Test(arguments: ["dock", "menu"])
    func `healthy browser gateway focus preserves document`(_ entry: String) async throws {
        let url = try #require(URL(string: "https://gateway.example.invalid/"))
        let endpointURL = try #require(URL(string: "wss://gateway.example.invalid/"))
        let session = try GatewayBrowserSession(
            origin: url,
            issuer: url,
            audience: "fixture",
            subject: "fixture",
            token: "synthetic",
            expiresAt: Date().addingTimeInterval(7200))
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: store.dataStore,
            browserSessionLease: store.lease(for: session),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        let manager = DashboardManager._testMake(
            automaticGatewayProfileRefreshEnabled: false,
            profileEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (endpointURL, nil, nil), routeAuthority: nil, browserSession: session)
            })
        defer { manager.close() }
        manager._testSetController(controller)
        manager._testSetMainTarget(.profile("studio"))
        controller.show()
        try controller.nativeBrowser.open(
            tabId: "reading", url: #require(URL(string: "about:blank")), sessionKey: "fixture")
        let tab = try #require(controller.nativeBrowser.webView(for: "reading"))
        #expect(controller.hasCurrentBrowserSession)

        if entry == "dock" {
            try await manager.show()
        } else {
            await manager.openOrFocusDashboard(for: .profile("studio")).value
        }

        #expect(manager._testController() === controller)
        #expect(controller.nativeBrowser.webView(for: "reading") === tab)
        #expect(controller.isWindowOpen)
        #expect(manager.alertPresenter._testPendingAlerts.isEmpty)
    }

    private func withConfiguredPrimary(_ body: @MainActor () async throws -> Void) async throws {
        // An unconfigured app opens the saved profile during show(), before a
        // picker test can release the profile gate it intended to suspend later.
        try await TestIsolation.withIsolatedState(defaults: [connectionModeKey: "local"]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .local
            defer { state.connectionMode = previousMode }
            try await body()
        }
    }
}

@MainActor
extension DashboardManagerGatewayTargetTests {
    @Test(arguments: ["present", "initial-command"])
    func `superseded primary presentation preserves the selected profile`(_ entry: String) async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try Data("{}".utf8).write(to: URL(fileURLWithPath: configPath))
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_TOKEN": nil,
            "OPENCLAW_GATEWAY_PASSWORD": nil,
        ]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let gate = DashboardWindowOwnershipPresentationGate(released: true)
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { mode in
                    if mode == .remote { await gate.waitForRelease() }
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
                },
                profileEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil)
                },
                gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
            defer { manager.close() }
            if entry == "present" { try await manager.show() }
            await gate.hold()
            if entry == "present" {
                manager.presentDashboard()
            } else {
                manager.dispatchNativeCommand(.commandPalette)
            }
            await gate.waitUntilRequested()
            let presentation = Task { try await manager.show() }
            if entry == "initial-command" {
                let config = """
                {"gateway":{"port":\(server.port),"auth":{"token":"primary"}}}
                """
                try Data(config.utf8).write(to: URL(fileURLWithPath: configPath))
                // The native-ready endpoint may supersede a suspended lookup,
                // but configured credentials alone cannot present a fresh document.
                state.connectionMode = .local
                #expect(!manager.showConfiguredWindowIfPossible())
                // A newer explicit navigation resolves the now-ready local
                // owner independently of the suspended remote presentation.
                await manager.show(atPath: "/chat", target: .primary)
                #expect(manager._testController()?.auth.hasAcceptedNativeBinding == true)
                #expect(manager.showConfiguredWindowIfPossible())
            }
            let source = try #require(manager._testController())
            _ = await manager.switchTarget(.profile("secondary"), in: source)?.value
            let selected = try #require(manager._testController())
            #expect(manager._testMainTarget() == .profile("secondary"))
            await gate.release()
            do {
                try await presentation.value
            } catch {
                Issue.record("A superseded presentation reported failure: \(error)")
            }
            try await DashboardTestWait.document(selected, "selected profile document")
            #expect(manager._testController() === selected)
            #expect(selected.auth.token == "secondary")
            #expect(selected.canDeliverNativeCommands)
            #expect(selected.isWindowOpen)
        }
    }

    @Test(arguments: ["reconnect-during-recovery", "command-during-picker"])
    func `window commands survive the current gateway transition`(_ scenario: String) async throws {
        let responseGate = DashboardWindowOwnershipPresentationGate(released: true)
        let primaryGate = DashboardWindowOwnershipPresentationGate(released: true)
        let profileGate = DashboardWindowOwnershipPresentationGate(released: true)
        let catalogGate = DashboardWindowOwnershipPresentationGate(released: true)
        let server = try await DashboardHTTPFixture.start(
            html: """
            <html><body><script>
            window.commandEvents = [];
            window.addEventListener('openclaw:native-toggle-search', event => {
              event.preventDefault(); window.commandEvents.push('palette');
            });
            </script></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'",
            beforeResponse: { await responseGate.waitForRelease() })
        defer {
            server.stop()
            Task {
                await responseGate.release()
                await primaryGate.release()
                await catalogGate.release()
            }
        }
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await primaryGate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
            },
            profileEndpointProvider: { _ in
                await profileGate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil)
            },
            gatewayEntriesProvider: {
                let read = await catalogGate.waitForRelease()
                var entries = DashboardGatewayTestEntries.withProfiles(["secondary"])
                entries[0] = DashboardGatewayEntry(
                    id: "primary",
                    name: "Catalog \(read)",
                    kind: "local",
                    isPrimary: true,
                    canPromote: false,
                    health: .ok)
                return entries
            })
        defer { manager.close() }
        let reconnect = scenario == "reconnect-during-recovery"
        await manager._testOpenWindow(for: reconnect ? .primary : .profile("secondary"))
        let original = try #require(manager._testAuxiliaryWindows().first?.controller)
        let window = try #require(original.window)
        original.showFailure(title: "Unavailable", message: "Synthetic connection failure")
        if reconnect {
            await responseGate.hold()
            await catalogGate.hold()
        } else {
            await primaryGate.hold()
            manager.handleGatewayRequest(.select(.primary), from: original)
            await primaryGate.waitUntilRequested()
        }
        manager.dispatchNativeCommand(.commandPalette)
        manager.dispatchNativeCommand(.commandPalette)
        if reconnect {
            await catalogGate.waitUntilRequested()
            await manager.handleEndpointState(.connecting(mode: .remote, detail: "Reconnecting"))
            await catalogGate.release()
            try await TestWait.state("reconnected gateway catalog") {
                manager.gatewayEntries.first?.name == "Catalog 2"
            }
            #expect(manager.gatewayEntries.first?.name == "Catalog 2")
            await manager.handleEndpointState(.ready(
                mode: .remote, url: server.websocketURL(), token: "reconnected", password: nil, routeRevision: 2))
            await responseGate.release()
        } else {
            // Wait until the command has entered either the current window or an endpoint recovery.
            try await TestWait.state("gateway command admission") {
                if !original._testPendingNativeCommands.isEmpty { return true }
                return await profileGate.numberOfRequests() != 1
            }
            await primaryGate.release()
        }
        var events: [String] = []
        // The window's controller can change mid-transition, so re-read it on every pass.
        try await TestWait.state("transition command delivery") {
            guard let current = window.windowController as? DashboardWindowController else { return false }
            events = await (try? current.webView.evaluateJavaScript("window.commandEvents") as? [String]) ?? []
            return !current.webView.isLoading && events == ["palette", "palette"] &&
                manager._testAuxiliaryWindows().first?.target == .primary
        }
        #expect(manager._testAuxiliaryWindows().first?.target == .primary)
        #expect(events == ["palette", "palette"])
        #expect((window.windowController as? DashboardWindowController)?.auth.token ==
            (reconnect ? "reconnected" : "primary"))
    }

    @Test(arguments: [
        "primary-endpoint",
        "primary-reconnect",
        "profile-credentials",
        "profile-reconnect",
        "picker",
        "close",
    ])
    func `loading document actions follow only the surviving window selection`(_ scenario: String) async throws {
        let responseGate = DashboardWindowOwnershipPresentationGate()
        let html = """
        <html><body><script>
        window.commandEvents = [];
        window.addEventListener('openclaw:native-new-session', () => window.commandEvents.push('new-session'));
        window.addEventListener('openclaw:native-toggle-search', event => {
          event.preventDefault(); window.commandEvents.push('palette');
        });
        window.addEventListener('openclaw:native-navigate', event => {
          event.preventDefault(); history.pushState({}, '', event.detail.path);
          window.commandEvents.push('navigation');
        });
        window.__OPENCLAW_NATIVE_COMMANDS_READY__ = true;
        window.dispatchEvent(new Event('openclaw:native-commands-state'));
        </script></body></html>
        """
        let server = try await DashboardHTTPFixture.start(
            html: html,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'",
            beforeResponse: { await responseGate.waitForRelease() })
        let replacementServer = try await DashboardHTTPFixture.start(
            html: html, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer {
            server.stop()
            replacementServer.stop()
            Task { await responseGate.release() }
        }
        let source = GatewayConnectionEndpointSource(url: server.websocketURL(), token: "before")
        let profile = scenario.hasPrefix("profile-") || scenario == "picker" || scenario == "close"
        let identity = scenario == "profile-reconnect" ? try DashboardIdentityFixture(
            announcement: nil, source: source) : nil
        let manager = DashboardManager._testMake(
            connectionProvider: { target in
                if let identity { return identity.connection }
                switch target {
                case .primary: return GatewayConnection.shared
                case .local: return await MacGatewayConnectionFleet.shared.localConnection()
                case let .profile(id): return await MacGatewayConnectionFleet.shared.connection(profileID: id)
                }
            },
            browserIdentityURLProvider: { _, config in
                guard let identity else { return nil }
                let announcement = try await identity.connection.controlUiBrowserIdentityURL(config: config)
                return announcement == nil ? nil : server.url()
            },
            observeGatewayChanges: scenario.hasPrefix("profile-"),
            primaryEndpointProvider: { _ in
                scenario == "picker"
                    ? GatewayConnection.EndpointSnapshot(
                        config: (url: replacementServer.websocketURL(), token: "after", password: nil),
                        routeAuthority: nil)
                    : source.snapshot()
            },
            profileEndpointProvider: { _ in source.snapshot() },
            gatewayEntriesProvider: { DashboardGatewayTestEntries.withProfiles(["secondary"]) })
        defer { manager.close() }
        do {
            await manager._testOpenWindow(for: profile ? .profile("secondary") : .primary)
            await responseGate.waitUntilRequested()
            let original = try #require(manager._testAuxiliaryWindows().first?.controller)
            let window = try #require(original.window)
            #expect(original.webView.isLoading)
            #expect(original.canDeliverNativeCommands)
            manager.dispatchNativeCommand(.newSession)
            manager.dispatchNativeCommand(.commandPalette)
            manager.dispatchNativeCommand(.commandPalette)
            #expect(original._testPendingNativeCommands == [.newSession, .commandPalette, .commandPalette])
            let path = "/chat/main/dashboard/preserved"
            original.dispatchNativeNavigation(DashboardNativeNavigation(
                path: path, search: nil, fallbackURL: server.url(path)))
            let intent = original.windowIntentGeneration

            switch scenario {
            case "close":
                window.performClose(nil)
                #expect(original._testPendingNativeCommands.isEmpty)
                #expect(original._testPendingNativeNavigation == nil)
                #expect(manager._testAuxiliaryWindows().isEmpty)
                await identity?.connection.shutdown()
                return
            case "picker":
                manager.handleGatewayRequest(.select(.primary), from: original)
            case "profile-credentials":
                source.setEndpoint(GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: "after", password: nil), routeAuthority: nil))
                NotificationCenter.default.post(name: MacGatewayProfileStore.didChangeNotification, object: nil)
            case "profile-reconnect":
                try await identity?.reconnect(announcement: "https://renewed.example.test/")
            default:
                if scenario == "primary-reconnect" {
                    await manager.handleEndpointState(.connecting(mode: .remote, detail: "Reconnecting"))
                }
                await manager.handleEndpointState(.ready(
                    mode: .remote,
                    url: replacementServer.websocketURL(),
                    token: "after",
                    password: nil,
                    routeRevision: 2))
            }
            try await TestWait.state("replacement gateway controller") {
                window.windowController !== original
            }
            let replacement = try #require(window.windowController as? DashboardWindowController)
            #expect(replacement !== original)
            #expect(replacement.window === window)
            if scenario != "picker" { #expect(replacement.windowIntentGeneration == intent) }
            await responseGate.release()
            let expected = scenario == "picker" ? [] :
                ["new-session", "palette", "palette"] + (scenario.hasPrefix("profile-") ? ["navigation"] : [])
            var events: [String] = []
            try await DashboardTestWait.document(replacement, "replacement gateway document")
            try await TestWait.state("replacement command delivery") {
                events = await (try? replacement.webView.evaluateJavaScript("window.commandEvents") as? [String]) ?? []
                return events == expected
            }
            #expect(events == expected)
            #expect(replacement.webView.url?.path == (scenario.hasPrefix("profile-") ? path : "/"))
        } catch {
            await identity?.connection.shutdown()
            throw error
        }
        await identity?.connection.shutdown()
    }
}

private enum DashboardGatewayTestEntries {
    static func withProfiles(_ profileIDs: [String]) -> [DashboardGatewayEntry] {
        [
            DashboardGatewayEntry(
                id: "primary",
                name: "Local Gateway",
                kind: "local",
                isPrimary: true,
                canPromote: false,
                health: .ok),
        ] + profileIDs.map { profileID in
            DashboardGatewayEntry(
                id: "profile:\(profileID)",
                name: profileID.capitalized,
                kind: "remote",
                isPrimary: false,
                canPromote: true,
                health: .unknown)
        }
    }
}

@MainActor
private final class DashboardGatewayTestUpdater: UpdaterProviding {
    var automaticallyChecksForUpdates = false
    var automaticallyDownloadsUpdates = false
    let isAvailable = true
    let updateStatus = UpdateStatus()

    func checkForUpdates(_: Any?) {}
}

@MainActor
struct DashboardPrimaryGatewayAdapterTests {
    @Test(arguments: [nil, String(repeating: "a", count: 64)] as [String?])
    func `token profile promotion carries its authentication and TLS policy`(fingerprint: String?) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            let url = try #require(URL(string: "wss://studio.example:443/"))
            let adapter = DashboardPrimaryGatewayAdapter(
                state: state,
                endpoint: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: url, token: "profile-token", password: nil),
                        tls: DashboardGatewayTestTLS.route(fingerprint: fingerprint),
                        routeAuthority: nil)
                })

            try await adapter.apply(profileID: "studio")

            let root = OpenClawConfigFile.loadDict()
            #expect(GatewayRemoteConfig.resolveGatewayUrl(root: root) == url)
            #expect(GatewayRemoteConfig.resolveTokenString(root: root) == "profile-token")
            #expect(GatewayRemoteConfig.resolvePasswordString(root: root) == nil)
            #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: root) == fingerprint)
        }
    }

    @Test func `password only profile cannot be promoted`() async throws {
        let state = AppState(preview: true)
        let url = try #require(URL(string: "wss://studio.example:443/"))
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            endpoint: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: nil, password: "secret"),
                    routeAuthority: nil)
            })
        await #expect(throws: DashboardPrimaryGatewayError.notPromotable) {
            try await adapter.apply(profileID: "studio")
        }
    }
}

private enum DashboardGatewayTestTLS {
    static func route(fingerprint: String?) -> GatewayTLSRoute {
        GatewayTLSRoute(
            params: GatewayTLSParams(
                required: true,
                expectedFingerprint: fingerprint,
                allowTOFU: fingerprint == nil,
                storeKey: nil),
            allowsTrustedPinReplacement: true)
    }
}

@MainActor
struct DashboardGatewaysRequestTests {
    @Test func `parses gateway bridge requests with role based ids`() {
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "select", "id": "primary"]) == .select(.primary))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "open-window", "id": "profile:studio"]) == .openWindow(.profile("studio")))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "set-primary", "id": "profile:studio"]) == .setPrimary(.profile("studio")))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect", "id": "profile:studio"]) == .reconnect(.profile("studio")))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect-cancel", "id": "profile:studio"]) == .reconnectCancel(.profile("studio")))
        let attempt = UUID()
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect-browser", "id": "profile:studio", "attempt": attempt.uuidString])
            == .reconnectBrowser(.profile("studio"), attempt))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect-browser", "id": "profile:studio"]) == nil)
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect"]) == nil)
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "reconnect", "id": "https://secret.example"]) == nil)
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "open-settings"]) == .openSettings)
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "select", "id": "https://secret.example"]) == nil)
    }
}
