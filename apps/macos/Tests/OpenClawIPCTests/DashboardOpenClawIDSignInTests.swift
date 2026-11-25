import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

/// Real WK message delivery, a real HTTP issuer page, and real redirect navigation.
/// This proves the native return channel, not the live issuer or the full Control UI menu.
@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardOpenClawIDSignInTests {
    @Test(arguments: ["code", "denial", "wrong-state"])
    func `returns the issuer callback to the requesting dashboard document`(_ outcome: String) async throws {
        _ = AppKitTestSupport.application
        let dashboard = try await DashboardHTTPFixture.start()
        defer { dashboard.stop() }
        let issuer = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><button id="continue">Continue</button><script>
            document.getElementById('continue').onclick = () => {
              const query = new URLSearchParams(location.search);
              const callback = new URL(query.get('redirect_uri'));
              callback.searchParams.set('state', query.get('state'));
              callback.searchParams.set('code', 'fixture-code');
              location.assign(callback.href);
            };
            </script>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { issuer.stop() }
        let controller = Self.controller(dashboard)
        defer { controller.closeDashboard() }
        controller.show(url: controller.currentURL, auth: controller.auth)
        try await waitForNativeDashboardDocument(controller)
        try await Self.begin(controller, authorization: Self.authorization(issuer, dashboard))
        let popup = try await Self.popup(controller)
        let webView = try #require(popup.contentView as? WKWebView)
        try await TestWait.state("issuer document") { !webView.isLoading && webView.url?.host != nil }
        // The login shares cookies with this app, not its privileged scripts or device bridge.
        #expect(webView.configuration.websiteDataStore === controller.webView.configuration.websiteDataStore)
        #expect(try await webView.evaluateJavaScript("typeof window.webkit?.messageHandlers?.openclawDeviceSettings")
            as? String == "undefined")
        #expect(try await webView.evaluateJavaScript("typeof window.webkit?.messageHandlers?.OpenClawNativeGatewayAuth")
            as? String == "undefined")
        if outcome == "code" {
            _ = try await webView.evaluateJavaScript("document.getElementById('continue').click(); true")
        } else {
            var callback = URLComponents(url: dashboard.url("/control/openclaw-id/callback"), resolvingAgainstBaseURL: false)!
            callback.queryItems = [
                .init(name: "state", value: outcome == "wrong-state" ? "another-attempt" : "fixture-state"),
                .init(name: "error", value: "access_denied"),
            ]
            webView.load(URLRequest(url: try #require(callback.url)))
        }
        let reply = try await Self.reply(controller)
        if outcome == "wrong-state" {
            #expect(reply["failed"] as? Bool == true)
            #expect(reply["code"] == nil)
        } else {
            #expect(reply["state"] as? String == "fixture-state")
            #expect(reply["code"] as? String == (outcome == "code" ? "fixture-code" : nil))
            #expect(reply["error"] as? String == (outcome == "denial" ? "access_denied" : nil))
        }
        #expect(popup.isVisible == false)
        #expect(controller.window?.childWindows?.isEmpty != false)
        #expect(controller.webView.url == dashboard.url("/control/"))
    }

    @Test(arguments: ["popup", "dashboard"])
    func `closing the login or dashboard settles the original request`(_ target: String) async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        controller.show(url: controller.currentURL, auth: controller.auth)
        try await waitForNativeDashboardDocument(controller)
        try await Self.begin(controller, authorization: Self.authorization(server, server))
        let popup = try await Self.popup(controller)
        if target == "popup" { popup.performClose(nil) } else { controller.closeDashboard() }
        let reply = try await Self.reply(controller)
        #expect(reply["failed"] as? Bool == true)
        #expect(popup.isVisible == false)
    }

    @Test(arguments: ["subframe", "outside-mount", "outside-callback"])
    func `untrusted requests cannot open a login window`(_ source: String) async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            contentSecurityPolicy: "default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        controller.show(url: controller.currentURL, auth: controller.auth)
        try await waitForNativeDashboardDocument(controller)
        var authorization = Self.authorization(server, server)
        if source == "outside-callback" {
            var url = URLComponents(url: authorization, resolvingAgainstBaseURL: false)!
            url.queryItems = [
                .init(name: "state", value: "fixture-state"),
                .init(name: "redirect_uri", value: server.url("/outside/openclaw-id/callback").absoluteString),
            ]
            authorization = try #require(url.url)
        }
        if source == "outside-mount" {
            _ = try await controller.webView.evaluateJavaScript("history.pushState({}, '', '/outside')")
        }
        if source == "subframe" {
            let result = try await controller.webView.callAsyncJavaScript("""
            return await new Promise(resolve => {
              window.finishSignInTest = resolve;
              const frame = document.createElement('iframe');
              frame.srcdoc = '<script>window.webkit.messageHandlers.openclawIdSignIn.postMessage(' +
                JSON.stringify({authorizationUrl: authorization}) +
                ').then(() => parent.finishSignInTest(false), () => parent.finishSignInTest(true));</script>';
              document.body.append(frame);
            });
            """, arguments: ["authorization": authorization.absoluteString], in: nil, contentWorld: .page)
            #expect(result as? Bool == true)
        } else {
            try await Self.begin(controller, authorization: authorization)
            #expect(try await Self.reply(controller)["failed"] as? Bool == true)
        }
        #expect(controller.window?.childWindows?.isEmpty != false)
    }

    private static func controller(_ server: DashboardHTTPFixture) -> DashboardWindowController {
        DashboardWindowController(
            url: server.url("/control/"), auth: .unauthenticated,
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
    }

    private static func authorization(_ issuer: DashboardHTTPFixture, _ dashboard: DashboardHTTPFixture) -> URL {
        var url = URLComponents(url: issuer.url("/authorize"), resolvingAgainstBaseURL: false)!
        url.queryItems = [
            .init(name: "state", value: "fixture-state"),
            .init(name: "redirect_uri", value: dashboard.url("/control/openclaw-id/callback").absoluteString),
        ]
        return url.url!
    }

    private static func begin(_ controller: DashboardWindowController, authorization: URL) async throws {
        let available = try await controller.webView.callAsyncJavaScript("""
        const handler = window.webkit?.messageHandlers?.openclawIdSignIn;
        if (!handler) return false;
        window.signInTestReply = null;
        handler.postMessage({authorizationUrl: authorization}).then(
          result => { window.signInTestReply = result; },
          () => { window.signInTestReply = {failed: true}; });
        return true;
        """, arguments: ["authorization": authorization.absoluteString], in: nil, contentWorld: .page)
        // Fails on the base at the missing native entry point, rather than waiting for a timeout.
        try #require(available as? Bool == true, "The dashboard has no native OpenClaw ID return channel")
    }

    private static func popup(_ controller: DashboardWindowController) async throws -> NSWindow {
        try await TestWait.state("app-owned sign-in window") {
            controller.window?.childWindows?.contains(where: { $0.contentView is WKWebView }) == true
        }
        return try #require(controller.window?.childWindows?.first(where: { $0.contentView is WKWebView }))
    }

    private static func reply(_ controller: DashboardWindowController) async throws -> [String: Any] {
        try await TestWait.state("native sign-in reply") {
            try await controller.webView.evaluateJavaScript("window.signInTestReply !== null") as? Bool == true
        }
        return try #require(try await controller.webView.evaluateJavaScript("window.signInTestReply") as? [String: Any])
    }
}
