import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardGatewayHealthTests {
    @Test func `current document health updates every window snapshot and survives catalog refresh`() async throws {
        try await self.withFixture { manager, server in
            let first = try await self.open(.profile("first"), in: manager)
            #expect(first.auth.usesBrowserIdentity)
            #expect(first.auth.gatewayUrl == server.websocketURL("/control/").absoluteString)
            try await self.waitUntil { self.health(.profile("first"), in: manager) == .ok }
            #expect(self.health(.profile("second"), in: manager) == .unknown)
            let second = try await self.open(.profile("second"), in: manager)
            try await self.report(.error, from: second)
            try await self.waitUntil { self.health(.profile("second"), in: manager) == .error }
            await manager.refreshGatewaySnapshots()

            for (target, controller) in manager.dashboardControllers() {
                try await self.waitUntil {
                    let snapshot = try await self.snapshot(in: controller)
                    return snapshot?.currentId == target.bridgeID &&
                        snapshot?.gateways.first { $0.id == "profile:first" }?.health == .ok &&
                        snapshot?.gateways.first { $0.id == "profile:second" }?.health == .error
                }
            }
            #expect(first.gatewaySnapshot?.currentId == "profile:first")
            #expect(second.gatewaySnapshot?.currentId == "profile:second")
        }
    }

    func withFixture(
        _ body: (DashboardManager, DashboardHTTPFixture) async throws -> Void) async throws
    {
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head><script>
            // No wake here: didFinish must read an already connected document.
            if (!sessionStorage.getItem('fixture-signed-out')) {
              window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__ = {
                gatewayUrl: window.__OPENCLAW_NATIVE_CONTROL_AUTH__.gatewayUrl, health: 'ok'
              };
            }
            </script></head><body>Gateway fixture</body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'")
        defer { server.stop() }
        let suite = "DashboardGatewayHealthTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let entries = [DashboardGatewayEntry(
            id: "primary", name: "Primary", kind: "local",
            isPrimary: true, canPromote: false, health: .ok)] + ["first", "second"].map {
            DashboardGatewayEntry(
                id: "profile:\($0)", name: $0, kind: "remote",
                isPrimary: false, canPromote: false, health: .unknown)
        }
        let manager = DashboardManager._testMake(
            selection: MacGatewaySelectionPreferences(defaults: defaults),
            browserIdentityURLProvider: { target, _ in target == .primary ? nil : server.url("/control/") },
            primaryEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (server.websocketURL(), "fixture", nil), routeAuthority: nil)
            },
            profileEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (server.websocketURL("/device/"), "fixture", nil), routeAuthority: nil)
            },
            gatewayEntriesProvider: { entries })
        defer { manager.close() }
        await manager.refreshGatewaySnapshots()
        try await body(manager, server)
    }

    func open(
        _ target: DashboardGatewayTarget, in manager: DashboardManager) async throws -> DashboardWindowController
    {
        let previous = Set(manager.dashboardControllers().map { ObjectIdentifier($0.controller) })
        await manager.openNewDashboardWindow(for: target).value
        let controller = try #require(manager.dashboardControllers().first {
            $0.target == target && !previous.contains(ObjectIdentifier($0.controller))
        }?.controller)
        try await self.waitUntil { controller.canDeliverNativeCommands && !controller.webView.isLoading }
        return controller
    }

    func report(_ health: DashboardGatewayHealth, from controller: DashboardWindowController) async throws {
        try await controller.webView.evaluateJavaScript("""
        window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__ = {
          gatewayUrl: window.__OPENCLAW_NATIVE_CONTROL_AUTH__.gatewayUrl, health: '\(health.rawValue)'
        };
        window.dispatchEvent(new Event('openclaw:native-gateway-health-changed'));
        """)
    }

    func health(_ target: DashboardGatewayTarget, in manager: DashboardManager) -> DashboardGatewayHealth? {
        manager.gatewayEntries.first { $0.id == target.bridgeID }?.health
    }

    func snapshot(in controller: DashboardWindowController) async throws -> DashboardGatewaySnapshot? {
        guard let json = try await controller.webView.evaluateJavaScript(
            "JSON.stringify(window.__OPENCLAW_NATIVE_GATEWAYS__)") as? String else { return nil }
        return try JSONDecoder().decode(DashboardGatewaySnapshot.self, from: Data(json.utf8))
    }

    func waitUntil(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while try await !condition() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
