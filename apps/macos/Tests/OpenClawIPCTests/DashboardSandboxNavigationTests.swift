import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct DashboardSandboxNavigationTests {
    @Test(arguments: [
        ("openclaw://dashboard", "/control/chat", true, 1, true),
        ("openclaw://agent?message=Hello", "/control/chat", true, 1, true),
        ("openclaw://dashboard", "/control/chat", true, 0, false),
        ("openclaw://dashboard", "/control/chat", false, 1, false),
        ("openclaw://dashboard", "/login", true, 1, false),
        ("openclaw://dashboard", "https://other.example/control/chat", true, 1, false),
        ("openclaw://unknown", "/control/chat", true, 1, false),
        ("file:///tmp/example", "/control/chat", true, 1, false),
        ("https://other.example", "/control/chat", true, 1, false),
    ])
    func `app actions require a real click from the trusted dashboard main frame`(
        address: String, source: String, mainFrame: Bool, button: Int, allowed: Bool) throws
    {
        let dashboardURL = try #require(URL(string: "https://gateway.example/control/"))
        let url = try #require(URL(string: address))
        let sourceURL = try #require(URL(string: source, relativeTo: dashboardURL)?.absoluteURL)
        #expect(ControlUIDocumentHost.shouldHandleAppLinkNavigation(
            url,
            navigationType: .linkActivated,
            buttonNumber: button,
            sourceURL: sourceURL,
            sourceIsMainFrame: mainFrame,
            dashboardURL: dashboardURL) == allowed)
        #expect(!ControlUIDocumentHost.shouldHandleAppLinkNavigation(
            url,
            navigationType: .other,
            buttonNumber: button,
            sourceURL: sourceURL,
            sourceIsMainFrame: mainFrame,
            dashboardURL: dashboardURL))
    }

    @Test(arguments: [
        ("http://[fd12:3456:789a::1]:18789/control/", "http://[fd12:3456:789a::1]:18789"),
        ("https://Gateway.Example:443/control/", "https://gateway.example"),
        ("http://Gateway.Example:80/control/", "http://gateway.example"),
        ("https://gateway.example:8443/control/", "https://gateway.example:8443"),
    ])
    func `dashboard origins match browser normalization`(address: String, expectedOrigin: String) throws {
        let url = try #require(URL(string: address))
        let browserURL = try #require(URL(string: expectedOrigin + "/control/chat"))
        #expect(ControlUIDocumentHost.originString(for: url) == expectedOrigin)
        #expect(ControlUIDocumentHost.isTrustedLinkSource(browserURL, dashboardURL: url))
        #expect(ControlUIDocumentHost.shouldAllowNavigation(
            to: browserURL, dashboardURL: url, isMainFrame: true))
    }

    @Test(arguments: [
        ("https://login.example/sign-in", true),
        ("http://login.example/sign-in", false),
        ("https://user@login.example/sign-in", false),
        ("file:///sign-in", false),
    ])
    func `identity redirects require browser auth and secure credential-free URLs`(
        address: String, allowed: Bool) throws
    {
        let url = try #require(URL(string: address))
        let browserAuth = DashboardWindowAuth.browserIdentity(gatewayUrl: "wss://gateway.example/control/")
        #expect(ControlUIDocumentHost.shouldAllowIdentityNavigation(
            to: url,
            auth: browserAuth,
            isMainFrame: true,
            sourceIsDashboard: true,
            navigationType: .other) == allowed)
        #expect(!ControlUIDocumentHost.shouldAllowIdentityNavigation(
            to: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: "fixture", password: nil),
            isMainFrame: true,
            sourceIsDashboard: true,
            navigationType: .other))
        #expect(!ControlUIDocumentHost.shouldAllowIdentityNavigation(
            to: url,
            auth: browserAuth,
            isMainFrame: true,
            sourceIsDashboard: true,
            navigationType: .linkActivated))
        #expect(ControlUIDocumentHost.shouldAllowIdentityNavigation(
            to: url,
            auth: browserAuth,
            isMainFrame: true,
            sourceIsDashboard: false,
            navigationType: .formSubmitted) == allowed)
    }

    @Test func `sign-in documents cannot observe native data or consume pending commands`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head></head><body><script>
            window.commands = 0;
            window.addEventListener('openclaw:native-new-session', () => window.commands++);
            window.addEventListener('openclaw:native-navigate', event => {
              window.navigation = event.detail.path;
              event.preventDefault();
            });
            window.__OPENCLAW_NATIVE_COMMANDS_READY__ = location.pathname.startsWith('/control/');
            window.dispatchEvent(new Event('openclaw:native-commands-state'));
            </script></body></html>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let dashboardURL = server.url("/control/")
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL("/control/").absoluteString)
        let snapshot = DashboardGatewaySnapshot(gateways: [.init(
            id: "primary",
            name: "Private Gateway",
            kind: "remote",
            isPrimary: true,
            canPromote: false,
            health: .ok)], currentId: "primary")
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            gatewaySnapshot: snapshot,
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        // A login outside the configured mount is untrusted even on the same origin.
        controller.webView.load(URLRequest(url: server.url("/login")))
        try await self.waitForDocument(controller, url: server.url("/login"))
        controller.updateGatewaySnapshot(snapshot)
        controller.dispatchNativeCommand(.newSession)
        controller.dispatchNativeNavigation(.init(
            path: "/chat/example",
            fallbackURL: server.url("/control/chat/example")))
        controller.show(url: dashboardURL, auth: auth)
        #expect(controller.webView.url == server.url("/login"))
        #expect(controller._testPendingNativeCommands == [.newSession])
        #expect(controller._testPendingNativeNavigation?.path == "/chat/example")
        let exposed = try await controller.webView.evaluateJavaScript("""
        [window.__OPENCLAW_NATIVE_CONTROL_AUTH__, window.__OPENCLAW_NATIVE_GATEWAYS__,
         window.__OPENCLAW_NATIVE_WEB_CHROME__, window.__OPENCLAW_NATIVE_HISTORY__,
         window.__OPENCLAW_NATIVE_NOTIFICATIONS__].some(value => value !== undefined)
        """) as? Bool
        #expect(exposed == false)
        #expect(try await controller.webView.evaluateJavaScript("window.commands") as? Int == 0)

        controller.webView.load(URLRequest(url: dashboardURL))
        try await self.waitForDocument(
            controller,
            url: dashboardURL,
            ready: "window.commands === 1 && window.navigation === '/chat/example'")
        #expect(try await controller.webView.evaluateJavaScript("window.commands") as? Int == 1)
        #expect(try await controller.webView.evaluateJavaScript("window.navigation") as? String == "/chat/example")
        #expect(try await controller.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_GATEWAYS__.gateways[0].name") as? String == "Private Gateway")
        #expect(try await controller.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_CONTROL_AUTH__.token === null && " +
                "window.__OPENCLAW_NATIVE_CONTROL_AUTH__.password === null") as? Bool == true)
    }

    private func waitForDocument(
        _ controller: DashboardWindowController,
        url: URL,
        ready: String = "document.readyState === 'complete'") async throws
    {
        try await DashboardTestWait.document(controller, "document at \(url.path)") { controller.webView.url == url }
        // Callers pass page-script facts that can settle after the load completes.
        try await DashboardTestWait.state("\(ready) at \(url.path)") {
            try await controller.webView.evaluateJavaScript(ready) as? Bool == true
        }
    }

    @Test func `same URL sign in retains commands until the current document installs its shell`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head></head><body>Sign in<script>
            window.commands = [];
            window.mountShell = () => {
              window.addEventListener('openclaw:native-new-session', () => window.commands.push('new'));
              window.addEventListener('openclaw:native-toggle-search', event => {
                window.commands.push('search'); event.preventDefault();
              });
              window.__OPENCLAW_NATIVE_COMMANDS_READY__ = true;
              window.dispatchEvent(new Event('openclaw:native-commands-state'));
            };
            </script></body></html>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let url = server.url()
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        let controller = DashboardWindowController(
            url: url,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: url, auth: auth)
        try await self.waitForDocument(controller, url: url)
        controller.dispatchNativeCommand(.newSession)
        controller.dispatchNativeCommand(.commandPalette)
        #expect(controller._testPendingNativeCommands == [.newSession, .commandPalette])

        _ = try await controller.webView.evaluateJavaScript("window.mountShell(); null")
        try await self.waitForDocument(controller, url: url, ready: "window.commands.join(',') === 'new,search'")
        controller.webView.reload()
        try await self.waitForDocument(
            controller, url: url, ready: "window.__OPENCLAW_NATIVE_COMMANDS_READY__ === undefined")
        controller.dispatchNativeCommand(.newSession)
        // A queued notification from the previous same-URL shell is only a wakeup;
        // the new sign-in document still has no listener-owned readiness fact.
        _ = try await controller.webView.evaluateJavaScript(
            "window.webkit.messageHandlers.openclawCommands.postMessage({type: 'commands-state'}); null")
        #expect(controller._testPendingNativeCommands == [.newSession])
        #expect(try await controller.webView.evaluateJavaScript("window.commands.length") as? Int == 0)
        _ = try await controller.webView.evaluateJavaScript("window.mountShell(); null")
        try await self.waitForDocument(controller, url: url, ready: "window.commands.join(',') === 'new'")
    }

    @Test func `blob documents cannot inherit the root dashboard native credentials`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let dashboardURL = server.url("/")
        let auth = DashboardWindowAuth(
            gatewayUrl: server.websocketURL().absoluteString, token: "fixture-token", password: nil)
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: dashboardURL, auth: auth)
        try await self.waitForDocument(controller, url: dashboardURL)
        let blobAddress = try #require(try await controller.webView.evaluateJavaScript("""
        URL.createObjectURL(new Blob(['<!doctype html><html><head></head><body>Attachment</body></html>'],
                                    {type: 'text/html'}))
        """) as? String)
        let blobURL = try #require(URL(string: blobAddress))
        controller.webView.load(URLRequest(url: blobURL))
        try await self.waitForDocument(controller, url: blobURL)
        // Blob URLs keep their creator's origin; origin equality alone is not document trust.
        #expect(try await controller.webView.evaluateJavaScript("location.origin") as? String ==
            ControlUIDocumentHost.originString(for: dashboardURL))
        #expect(try await controller.webView.evaluateJavaScript("""
        [window.__OPENCLAW_NATIVE_CONTROL_AUTH__, window.__OPENCLAW_NATIVE_WEB_CHROME__,
         window.__OPENCLAW_NATIVE_HISTORY__].every(value => value === undefined)
        """) as? Bool == true)
        #expect(!ControlUIDocumentHost.isTrustedLinkSource(blobURL, dashboardURL: dashboardURL))
    }

    @Test(arguments: [
        "https://widgets.example/mcp-app-sandbox?csp=encoded",
        "http://127.0.0.1:18790/mcp-app-sandbox?csp=encoded",
        "https://widgets.example/mcp-app",
        "https://widgets.example/mcp-app-sandbox/",
        "https://widgets.example//mcp-app-sandbox",
        "https://widgets.example/%6dcp-app-sandbox",
        "https://widgets.example/mcp-app-sandbox%2f",
    ])
    func `sandbox navigation requires a trusted dashboard subframe`(_ address: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        let sandbox = try #require(URL(string: address))
        #expect(ControlUIDocumentHost.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(!ControlUIDocumentHost.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: true, isTrustedDashboardSource: true))
        #expect(!ControlUIDocumentHost.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: false))
    }

    @Test(arguments: [
        "file:///mcp-app-sandbox",
        "custom://widgets.example/mcp-app-sandbox",
    ])
    func `sandbox navigation rejects unsafe schemes`(_ address: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        let sandbox = try #require(URL(string: address))
        #expect(!ControlUIDocumentHost.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
    }

    @Test func `sandbox navigation rejects user information`() throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        var sandbox = try #require(URLComponents(string: "https://widgets.example/mcp-app-sandbox"))
        sandbox.user = "fixture-user"
        #expect(try !ControlUIDocumentHost.shouldAllowNavigation(
            to: #require(sandbox.url), dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        sandbox.user = nil
        sandbox.password = "fixture-password"
        #expect(try !ControlUIDocumentHost.shouldAllowNavigation(
            to: #require(sandbox.url), dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
    }

    @Test(arguments: ["/control/", "/team%20space/"])
    func `dashboard source trust preserves the browser pathname`(_ mountPath: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example\(mountPath)"))
        let descendant = try #require(URL(string: "chat", relativeTo: dashboard)?.absoluteURL)
        #expect(ControlUIDocumentHost.allowedPath(for: dashboard) == mountPath)
        #expect(ControlUIDocumentHost.isTrustedLinkSource(dashboard, dashboardURL: dashboard))
        #expect(ControlUIDocumentHost.isTrustedLinkSource(descendant, dashboardURL: dashboard))
        let encodedSeparator = try #require(URL(string: "https://openclaw.example\(mountPath.dropLast())%2Fchat"))
        #expect(!ControlUIDocumentHost.isTrustedLinkSource(encodedSeparator, dashboardURL: dashboard))
    }

    @Test func `dashboard WebKit loads the isolated sandbox and its inner document`() async throws {
        let sandbox = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><body><script>
            addEventListener('message', event => {
              if (event.source !== parent || event.data !== 'load-app') return;
              const inner = document.createElement('iframe');
              inner.sandbox = 'allow-scripts';
              inner.srcdoc = '<body>MCP App rendered<script>parent.postMessage("app-ready", "*")<\\/script>';
              addEventListener('message', reply => {
                if (reply.source === inner.contentWindow && reply.data === 'app-ready') {
                  parent.postMessage({ready: true, nativeAuth: !!window.__OPENCLAW_NATIVE_CONTROL_AUTH__}, '*');
                }
              });
              document.body.append(inner);
            });
            parent.postMessage('proxy-ready', '*');
            </script>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'")
        defer { sandbox.stop() }
        let sandboxURL = sandbox.url("/mcp-app-sandbox?csp=encoded")
        let dashboard = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><body><h1>Dashboard</h1><script>
            const frame = document.createElement('iframe');
            frame.sandbox = 'allow-scripts allow-same-origin allow-forms';
            frame.referrerPolicy = 'origin';
            document.body.append(frame);
            addEventListener('message', event => {
              if (event.source !== frame.contentWindow) return;
              if (event.data === 'proxy-ready') frame.contentWindow.postMessage('load-app', '*');
              else if (event.data.ready) {
                document.body.dataset.appReady = String(!event.data.nativeAuth);
              }
            });
            frame.src = '\(sandboxURL.absoluteString)';
            </script>
            """,
            contentSecurityPolicy:
            "default-src 'none'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:\(sandbox.port)")
        defer { dashboard.stop() }
        let dashboardURL = dashboard.url("/control/")
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: "fixture-only", password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.loadInBackground(url: dashboardURL, auth: controller.auth)
        var rendered = false
        try await DashboardTestWait.state("sandbox inner document handshake") {
            rendered = await (try? controller.webView.evaluateJavaScript(
                "document.body.dataset.appReady")) as? String == "true"
            return rendered
        }
        #expect(rendered, "The real navigation delegate must admit the outer sandbox and nested srcdoc handshake")
        #expect(controller.webView.url == dashboardURL)
    }
}
