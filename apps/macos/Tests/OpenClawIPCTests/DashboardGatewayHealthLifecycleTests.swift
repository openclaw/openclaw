import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@MainActor
extension DashboardGatewayHealthTests {
    @Test func `connected evidence wins across windows and closing one preserves the other`() async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let first = try await self.open(target, in: manager)
            let second = try await self.open(target, in: manager)
            try await self.waitUntil { first.gatewayHealth == .ok && second.gatewayHealth == .ok }
            try await self.report(.error, from: first)
            try await self.waitUntil { first.gatewayHealth == .error }
            #expect(self.health(target, in: manager) == .ok)
            first.closeDashboard()
            #expect(self.health(target, in: manager) == .ok)
            try await self.report(.error, from: second)
            try await self.waitUntil { self.health(target, in: manager) == .error }
            try await self.report(.unknown, from: second)
            try await self.waitUntil { manager.dashboardHealth(for: target) == .unknown }
            second.closeDashboard()
            #expect(manager.dashboardHealth(for: target) == nil)
            #expect(self.health(target, in: manager) == .unknown)

            let reopened = try await self.open(target, in: manager)
            try await self.waitUntil { reopened.gatewayHealth == .ok }
            manager.close()
            #expect(manager.dashboardHealth(for: target) == nil)
            #expect(self.health(target, in: manager) == .unknown)
        }
    }

    @Test func `primary native health is only a fallback when the document has no evidence`() async throws {
        try await self.withFixture { manager, _ in
            #expect(self.health(.primary, in: manager) == .ok)
            let primary = try await self.open(.primary, in: manager)
            try await self.report(.unknown, from: primary)
            try await self.waitUntil { self.health(.primary, in: manager) == .unknown }
            try await self.report(.error, from: primary)
            try await self.waitUntil { self.health(.primary, in: manager) == .error }
            primary.invalidateBrowserSession()
            #expect(manager.dashboardHealth(for: .primary) == nil)
            #expect(self.health(.primary, in: manager) == .ok)
        }
    }

    @Test func `wake payload cannot attest health or a different Gateway`() async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let controller = try await self.open(target, in: manager)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            // The message lies; only the current document value is read.
            try await controller.webView.evaluateJavaScript("""
            window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__.health = 'error';
            window.webkit.messageHandlers.openclawGateways.postMessage({
              type: 'connection-state-changed', health: 'ok', id: 'profile:second'
            });
            true;
            """)
            try await self.waitUntil { self.health(target, in: manager) == .error }
            #expect(self.health(.profile("second"), in: manager) == .unknown)
            try await controller.webView.evaluateJavaScript("""
            window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__ = {gatewayUrl: 'wss://other.invalid/', health: 'ok'};
            window.dispatchEvent(new Event('openclaw:native-gateway-health-changed'));
            """)
            try await self.waitUntil { controller.gatewayHealth == nil }
            #expect(self.health(target, in: manager) == .unknown)
            try await self.report(.ok, from: controller)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            try await controller.webView.evaluateJavaScript("""
            window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__.health = 'not-a-health';
            window.dispatchEvent(new Event('openclaw:native-gateway-health-changed'));
            """)
            try await self.waitUntil { controller.gatewayHealth == nil }
        }
    }

    @Test func `subframes and sign in pages cannot publish Gateway health`() async throws {
        try await self.withFixture { manager, server in
            let target = DashboardGatewayTarget.profile("first")
            let controller = try await self.open(target, in: manager)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            try await controller.webView.evaluateJavaScript("""
            window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__.health = 'error';
            const frame = document.createElement('iframe');
            frame.id = 'health-frame';
            frame.srcdoc = `<script>
              window.webkit.messageHandlers.openclawGateways.postMessage({type: 'connection-state-changed'});
              parent.healthFrameSent = true;
            <\\/script>`;
            document.body.append(frame);
            """)
            try await self.waitUntil {
                try await controller.webView.evaluateJavaScript(
                    "window.healthFrameSent === true") as? Bool == true
            }
            #expect(controller.gatewayHealth == .ok)
            // The identical main-frame wake must consume the pending current value.
            try await controller.webView.evaluateJavaScript(
                "window.dispatchEvent(new Event('openclaw:native-gateway-health-changed'))")
            try await self.waitUntil { controller.gatewayHealth == .error }

            controller.webView.load(URLRequest(url: server.url("/login")))
            try await self.waitUntil {
                controller.webView.url == server.url("/login") &&
                    controller.canDeliverNativeCommands && !controller.webView.isLoading
            }
            _ = try await controller.webView.callAsyncJavaScript(
                """
                window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__ = {gatewayUrl, health: 'ok'};
                window.webkit.messageHandlers.openclawGateways.postMessage({type: 'connection-state-changed'});
                """,
                arguments: ["gatewayUrl": server.websocketURL("/control/").absoluteString],
                in: nil, contentWorld: .page)
            _ = try await controller.webView.evaluateJavaScript("document.readyState")
            #expect(controller.gatewayHealth == nil)
            #expect(self.health(target, in: manager) == .unknown)
        }
    }

    @Test(arguments: ["failure", "invalidated", "closed", "terminated"])
    func `retired window evidence cannot be restored by an in flight read`(_ retirement: String) async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let controller = try await self.open(target, in: manager)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            // Queue the real WebKit read and retire its owner in this same actor turn,
            // before the asynchronous completion can apply its connected value.
            controller.refreshGatewayHealth()
            switch retirement {
            case "failure": controller.showFailure(title: "Fixture", message: "Unavailable", present: false)
            case "invalidated": controller.invalidateBrowserSession()
            case "closed": controller.closeDashboard()
            default: controller.webViewWebContentProcessDidTerminate(controller.webView)
            }
            // Drain another WebKit evaluation after the queued read.
            _ = try? await controller.webView.evaluateJavaScript("document.readyState")
            #expect(controller.gatewayHealth == nil)
            #expect(manager.dashboardHealth(for: target) == nil)
            #expect(self.health(target, in: manager) == .unknown)
        }
    }

    @Test func `same URL replacement rejects wakes from its retired WebView`() async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let old = try await self.open(target, in: manager)
            try await self.waitUntil { old.gatewayHealth == .ok }
            let window = try #require(old.window)
            await manager.switchTarget(target, in: old, forceReload: true)?.value
            let replacement = try #require(window.windowController as? DashboardWindowController)
            #expect(replacement !== old)
            #expect(replacement.currentURL == old.currentURL)
            try await self.waitUntil { replacement.gatewayHealth == .ok }
            try await self.report(.error, from: replacement)
            try await self.waitUntil { self.health(target, in: manager) == .error }
            try await self.report(.ok, from: old)
            _ = try await old.webView.evaluateJavaScript("document.readyState")
            #expect(old.gatewayHealth == nil)
            #expect(self.health(target, in: manager) == .error)
        }
    }

    @Test func `same URL sign in document cannot inherit the preceding connection`() async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let controller = try await self.open(target, in: manager)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            let sourceID = controller.notificationSourceID
            try await controller.webView.evaluateJavaScript("sessionStorage.setItem('fixture-signed-out', 'true')")
            controller.webView.reload()
            try await self.waitUntil {
                controller.notificationSourceID != sourceID &&
                    controller.canDeliverNativeCommands && !controller.webView.isLoading
            }
            try await controller.webView.evaluateJavaScript("""
            window.webkit.messageHandlers.openclawGateways.postMessage({
              type: 'connection-state-changed', health: 'ok'
            });
            true;
            """)
            _ = try await controller.webView.evaluateJavaScript("document.readyState")
            #expect(controller.gatewayHealth == nil)
            #expect(self.health(target, in: manager) == .unknown)
            try await self.report(.ok, from: controller)
            try await self.waitUntil { self.health(target, in: manager) == .ok }
        }
    }

    @Test func `cancelled provisional navigation keeps the surviving document health`() async throws {
        try await self.withFixture { manager, _ in
            let target = DashboardGatewayTarget.profile("first")
            let controller = try await self.open(target, in: manager)
            try await self.waitUntil { controller.gatewayHealth == .ok }
            controller.webView(controller.webView, didStartProvisionalNavigation: nil)
            #expect(self.health(target, in: manager) == .ok)
            controller.webView(controller.webView, didFailProvisionalNavigation: nil, withError: URLError(.cancelled))
            _ = try await controller.webView.evaluateJavaScript("document.readyState")
            #expect(controller.gatewayHealth == .ok)
            #expect(self.health(target, in: manager) == .ok)
        }
    }
}
