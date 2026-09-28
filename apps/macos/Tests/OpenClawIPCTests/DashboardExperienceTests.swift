import AppKit
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardExperienceTests {
    @Test func `switching experiences retains documents and restores the selected Gateway`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url: server.websocketURL(), token: "fixture", password: nil), routeAuthority: nil)
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in endpoint },
            profileEndpointProvider: { _ in endpoint })
        defer { manager.close() }
        await manager.openNewDashboardWindow(for: .primary).value
        let primary = try #require(manager._testAuxiliaryWindows().first?.controller)
        await manager.openNewDashboardWindow(for: .profile("saved")).value
        let saved = try #require(manager._testAuxiliaryWindows().first { $0.target == .profile("saved") }?.controller)
        try await self.waitForDocument(saved)
        try await saved.webView.evaluateJavaScript("window.fixtureDraft = 'Keep this draft'")
        let savedWindow = try #require(saved.window)
        let primaryWindow = try #require(primary.window)
        try await AppKitTestSupport.performWindowTransition(
            primaryWindow, notification: NSWindow.didMiniaturizeNotification)
        {
            primaryWindow.miniaturize(nil)
        }
        saved.show()
        #expect(manager.hasVisibleWindows)

        try await AppKitTestSupport.performWindowTransition(
            primaryWindow, notification: NSWindow.didDeminiaturizeNotification)
        {
            manager.hideWindows()
            await manager.handleEndpointState(.ready(
                mode: .remote, url: server.websocketURL(), token: "renewed", password: nil, routeRevision: 2))
        }

        #expect(!manager.hasVisibleWindows)
        #expect(!primaryWindow.isVisible && !primaryWindow.isMiniaturized)
        #expect(!savedWindow.isVisible && !savedWindow.isMiniaturized)
        #expect(primaryWindow.isExcludedFromWindowsMenu && savedWindow.isExcludedFromWindowsMenu)
        #expect(manager.openWindowCount(for: .primary) == 1)
        #expect(manager.openWindowCount(for: .profile("saved")) == 1)
        #expect(try await saved.webView.evaluateJavaScript("window.fixtureDraft") as? String == "Keep this draft")

        try await manager.show()

        #expect(manager.frontmostDashboard()?.target == .profile("saved"))
        #expect(savedWindow.windowController === saved)
        #expect(savedWindow.isVisible && !savedWindow.isExcludedFromWindowsMenu)
        #expect(!primaryWindow.isVisible && primaryWindow.isExcludedFromWindowsMenu)
        #expect(try await saved.webView.evaluateJavaScript("window.fixtureDraft") as? String == "Keep this draft")

        manager.hideWindows()
        let renewed = try #require(primaryWindow.windowController as? DashboardWindowController)
        #expect(renewed.auth.token == "renewed")
        #expect(renewed.isHiddenForExperience)
        #expect(!primaryWindow.isVisible && primaryWindow.isExcludedFromWindowsMenu)

        // Native ordering must not promote a window the experience owner has hidden.
        primaryWindow.orderFront(nil)
        #expect(!renewed.isWindowOpen)
        #expect(manager.frontmostDashboard() == nil)
        manager.hideWindows()

        renewed.show()
        try await AppKitTestSupport.performWindowTransition(
            primaryWindow, notification: NSWindow.didMiniaturizeNotification)
        {
            primaryWindow.miniaturize(nil)
        }
        try await AppKitTestSupport.performWindowTransition(
            primaryWindow, notification: NSWindow.didDeminiaturizeNotification)
        {
            manager.hideWindows()
            renewed.show()
        }
        #expect(primaryWindow.windowController === renewed)
        #expect(!renewed.isHiddenForExperience)
        #expect(primaryWindow.isVisible && !primaryWindow.isExcludedFromWindowsMenu)
    }

    @Test(arguments: ["navigation", "new-window", "focus", "picker"])
    func `hiding windows fences pending opens and target changes`(_ action: String) async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let gate = DashboardWindowOwnershipPresentationGate()
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url: server.websocketURL(), token: "fixture", password: nil), routeAuthority: nil)
        let manager = DashboardManager._testMake(primaryEndpointProvider: { _ in
            await gate.waitForRelease()
            return endpoint
        })
        defer { manager.close() }
        let saved = self.makeController(server: server)
        manager._testSetController(saved)
        manager._testSetMainTarget(.profile("saved"))
        saved.show()
        let task: Task<Void, Never> = switch action {
        case "navigation":
            Task { await manager.show(atPath: "/settings/devices", target: .primary) }
        case "new-window":
            manager.openNewDashboardWindow(for: .primary)
        case "focus":
            manager.openOrFocusDashboard(for: .primary)
        default:
            try #require(manager.switchTarget(.primary, in: saved))
        }
        await gate.waitUntilRequested()
        manager.hideWindows()
        await gate.release()
        await task.value

        #expect(!manager.hasVisibleWindows)
        #expect(manager._testMainTarget() == .profile("saved"))
        #expect(manager._testController() === saved)
        #expect(manager.openWindowCount(for: .primary) == 0)
        #expect(saved._testPendingNativeNavigation == nil)
        #expect(manager._testPendingGatewayAlerts().isEmpty)
    }

    @Test func `a retired source socket cannot deliver a draft after Dashboard endpoint lookup`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let fixture = CronSourceFixture()
        let gate = DashboardWindowOwnershipPresentationGate()
        let manager = DashboardManager._testMake(primaryEndpointProvider: { _ in
            await gate.waitForRelease()
            return fixture.endpoint.value
        })
        defer { manager.close() }
        let saved = self.makeController(server: server)
        manager._testSetController(saved)
        manager._testSetMainTarget(.profile("saved"))
        saved.show()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let handoff = Task {
                await manager.show(
                    atPath: "/chat/main/main",
                    search: "?draft=Original%20Gateway%20draft",
                    target: .primary,
                    ifCurrent: { fixture.gateway.serverLeaseMatchesCurrentState(lease) })
            }
            await gate.waitUntilRequested()
            await fixture.gateway._test_handleDisconnect(socketGeneration: lease.socketGeneration)
            #expect(fixture.gateway.serverLeaseMatchesCurrentRoute(lease))
            #expect(!fixture.gateway.serverLeaseMatchesCurrentState(lease))
            await gate.release()
            await handoff.value

            #expect(manager.openWindowCount(for: .primary) == 0)
            #expect(manager._testController() === saved)
            #expect(manager._testMainTarget() == .profile("saved"))
            #expect(saved._testPendingNativeNavigation == nil)
            #expect(manager._testPendingGatewayAlerts().isEmpty)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `primary handoff leaves a saved Gateway document and draft in place`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><body><script>
            window.routes = [];
            window.addEventListener('openclaw:native-navigate', event => {
              window.routes.push(event.detail.path); event.preventDefault();
            });
            </script></body></html>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url: server.websocketURL(), token: "fixture", password: nil), routeAuthority: nil)
        let manager = DashboardManager._testMake(primaryEndpointProvider: { _ in endpoint })
        defer { manager.close() }
        let saved = self.makeController(server: server)
        manager._testSetController(saved)
        manager._testSetMainTarget(.profile("saved"))
        saved.show(url: server.url("/"), auth: saved.auth)
        try await self.waitForDocument(saved)
        try await saved.webView.evaluateJavaScript("window.fixtureDraft = 'Saved Gateway draft'")

        await manager.show(atPath: "/settings/devices", target: .primary)
        let primary = try #require(manager._testAuxiliaryWindows().first { $0.target == .primary }?.controller)
        try await self.waitForDocument(primary)
        #expect(try await primary.webView.evaluateJavaScript("window.routes") as? [String] == ["/settings/devices"])
        #expect(manager._testMainTarget() == .profile("saved"))
        #expect(manager._testController() === saved)
        #expect(try await saved.webView.evaluateJavaScript("window.fixtureDraft") as? String == "Saved Gateway draft")
        #expect(try await saved.webView.evaluateJavaScript("window.routes") as? [String] == [])
    }

    @Test func `a Gateway selection supersedes a suspended handoff to its old target`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let gate = DashboardWindowOwnershipPresentationGate()
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url: server.websocketURL(), token: "fixture", password: nil), routeAuthority: nil)
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await gate.waitForRelease()
                return endpoint
            },
            profileEndpointProvider: { _ in endpoint })
        defer { manager.close() }
        let primary = self.makeController(server: server)
        manager._testSetController(primary)
        primary.show()
        let handoff = Task { await manager.show(atPath: "/settings/devices", target: .primary) }
        await gate.waitUntilRequested()
        await manager.switchTarget(.profile("saved"), in: primary)?.value
        let saved = try #require(manager._testController())
        await gate.release()
        await handoff.value

        #expect(manager._testMainTarget() == .profile("saved"))
        #expect(manager._testController() === saved)
        #expect(saved._testPendingNativeNavigation == nil)
        #expect(manager.openWindowCount(for: .primary) == 0)
    }

    private func makeController(server: DashboardHTTPFixture) -> DashboardWindowController {
        DashboardWindowController(
            url: server.url("/"),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
    }

    private func waitForDocument(_ controller: DashboardWindowController) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if !controller.webView.isLoading, controller.canDeliverNativeCommands,
               try await controller.webView.evaluateJavaScript("document.readyState === 'complete'") as? Bool == true
            { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("The dashboard fixture did not finish loading")
    }
}
