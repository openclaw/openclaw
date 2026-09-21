import AppKit
import CryptoKit
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardSignInNavigationObserver: NSObject, WKNavigationDelegate {
    let controller: DashboardWindowController
    private var continuation: CheckedContinuation<Void, Error>?

    init(controller: DashboardWindowController) {
        self.controller = controller
    }

    func navigate(_ action: () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            do {
                try action()
            } catch {
                self.continuation = nil
                continuation.resume(throwing: error)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.controller.webView(webView, didFinish: navigation)
        self.continuation?.resume()
        self.continuation = nil
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.controller.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        self.controller.webView(webView, didReceive: challenge, completionHandler: completionHandler)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }
}

@MainActor
struct DashboardBrowserSignInRecoveryTests {
    @Test func `live browser identity sign-in reloads the chat in its own cookie store`() async throws {
        var receivedIdentityCookie = false
        var receivedRenewedCookie = false
        let server = try await DashboardHTTPFixture.start(requestHandler: { request in
            let cookie = request.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("cookie:") } ?? ""
            if request.hasPrefix("GET /control/attachment.svg ") {
                receivedRenewedCookie = cookie.contains("synthetic_app_session=renewed")
                let image = """
                <svg xmlns="http://www.w3.org/2000/svg" width="640" height="180">
                <rect width="640" height="180" rx="16" fill="#d8f3e7"/>
                <text x="320" y="88" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#125d40">
                Synthetic attachment loaded</text>
                <text x="320" y="126" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#125d40">
                Served with the renewed WebKit session cookie</text></svg>
                """
                return Self.response(
                    receivedRenewedCookie ? image : "Sign-in required",
                    type: receivedRenewedCookie ? "image/svg+xml" : "text/plain")
            }
            let recovered = request.hasPrefix("GET /control/chat/fixture?view=thread ") &&
                cookie.contains("sign-in-fixture=retained")
            if recovered { receivedIdentityCookie = true }
            return Self.response(
                Self.signInFixture(recovered: recovered),
                cookie: recovered ? "synthetic_app_session=renewed; Path=/control/; HttpOnly; SameSite=Strict" : nil)
        })
        defer { server.stop() }
        let store = WKWebsiteDataStore.nonPersistent()
        let baseURL = server.url("/control/")
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        let controller = DashboardWindowController(
            url: baseURL,
            auth: auth,
            websiteDataStore: store,
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let observer = DashboardSignInNavigationObserver(controller: controller)
        controller.webView.navigationDelegate = observer
        try await observer.navigate { controller.show(url: baseURL, auth: auth) }
        _ = try await controller.webView.evaluateJavaScript("""
        history.replaceState({}, '', '/control/chat/fixture?view=thread');
        localStorage.setItem('sign-in-draft', 'Keep this unsent draft');
        document.querySelector('textarea').value = localStorage.getItem('sign-in-draft');
        document.cookie = 'sign-in-fixture=retained; path=/';
        """)
        let chatURL = try #require(controller.webView.url)
        try await Self.capture(controller.webView, name: "browser-sign-in-before")

        try await observer.navigate {
            controller.reconnectGateway(.primary)
            // The old signed-out-only entry point returns without navigating.
            try #require(controller.webView.isLoading)
        }

        #expect(controller.webView.url == chatURL)
        #expect(controller.dashboardBaseURL == baseURL)
        #expect(controller.webView.configuration.websiteDataStore === store)
        #expect(receivedIdentityCookie)
        #expect(try await controller.webView.evaluateJavaScript(
            "localStorage.getItem('sign-in-draft')") as? String == "Keep this unsent draft")
        #expect(try await controller.webView.evaluateJavaScript(
            "document.cookie.includes('sign-in-fixture=retained')") as? Bool == true)
        #expect(try await controller.webView.evaluateJavaScript(
            "document.querySelector('textarea').value") as? String == "Keep this unsent draft")
        #expect(try await controller.webView.evaluateJavaScript(
            "document.querySelector('img').naturalWidth") as? Int == 640)
        #expect(receivedRenewedCookie)
        let renewedCookie = await store.httpCookieStore.allCookies().first { $0.name == "synthetic_app_session" }
        #expect(renewedCookie?.value == "renewed")
        #expect(renewedCookie?.isHTTPOnly == true)
        try await Self.capture(controller.webView, name: "browser-sign-in-after")
    }

    private static func response(_ body: String, type: String = "text/html", cookie: String? = nil) -> String {
        var headers = [
            "HTTP/1.1 200 OK",
            "Content-Type: \(type); charset=utf-8",
            "Content-Length: \(body.utf8.count)",
            "Cache-Control: no-store",
            "Connection: close",
            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; " +
                "style-src 'unsafe-inline'; img-src 'self'",
        ]
        if let cookie { headers.append("Set-Cookie: \(cookie)") }
        return headers.joined(separator: "\r\n") + "\r\n\r\n" + body
    }

    private static func signInFixture(recovered: Bool) -> String {
        let title = recovered ? "Content restored" : "Website sign-in expired"
        let attachment = recovered
            ? "<img src='/control/attachment.svg' width='640' height='180' alt='Synthetic attachment'>"
            : "<div class='attachment'>Attachment unavailable until sign-in is renewed</div>"
        return """
        <!doctype html><html lang="en"><meta charset="utf-8"><title>Native WebKit sign-in fixture</title>
        <style>
        * { box-sizing:border-box } body { margin:0; background:#101820; color:#e6edf3; font:17px -apple-system }
        header { padding:28px 40px; border-bottom:1px solid #33414d; color:#aab9c6 }
        main { max-width:880px; margin:48px auto } h1 { font-size:32px; margin:0 0 12px }
        p { color:#aab9c6; line-height:1.5 } article { background:#1b2732; border-radius:16px; padding:28px }
        .attachment { width:640px; height:180px; display:grid; place-items:center; background:#362b28;
        color:#ffb69e; border:1px dashed #b4755e; border-radius:16px }
        label { display:block; margin:28px 0 10px; color:#aab9c6 }
        textarea { width:100%; resize:none; padding:18px; color:#e6edf3; background:#14202a;
        border:1px solid #52616e; border-radius:10px; font:18px -apple-system }
        footer { margin-top:26px; font-size:14px; color:#aab9c6 }
        </style><header>OpenClaw · Synthetic native WebKit sign-in fixture</header><main>
        <h1>\(title)</h1><p>Current conversation: /control/chat/fixture?view=thread</p>
        <article><p>Please keep this conversation and its draft open while restoring the attachment.</p>
        \(attachment)<label for="draft">Unsent draft</label><textarea id="draft" rows="2"></textarea></article>
        <footer>Real macOS WKWebView and native reconnect owner. Synthetic HTTP authentication; no live account.</footer>
        </main><script>document.querySelector('textarea').value = localStorage.getItem('sign-in-draft') || '';</script>
        </html>
        """
    }

    private static func capture(_ webView: WKWebView, name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return }
        let image = try await webView.takeSnapshot(configuration: nil)
        let tiff = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiff))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try png.write(to: output.appendingPathComponent("\(name)-window.png"))
        let record: [String: Any] = [
            "name": name, "method": "WKWebView.takeSnapshot", "synthetic": true,
            "scope": "Native WebKit reconnect boundary fixture; not the production Control UI or live Cloudflare",
            "requiresVisualInspection": true,
        ]
        try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .prettyPrinted])
            .write(to: output.appendingPathComponent("\(name)-capture-status.json"))
    }

    @Test func `saved browser sign-in restores only its account and retires the route with its window`() async throws {
        let tls = try await DashboardTLSFixture()
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity)
        defer { server.stop() }
        func makeSession(subject: String) throws -> GatewayBrowserSession {
            try GatewayBrowserSession(
                origin: server.url(),
                issuer: #require(URL(string: "https://identity.cloudflareaccess.com/")),
                audience: "fixture",
                subject: subject,
                token: "synthetic",
                expiresAt: Date().addingTimeInterval(300))
        }
        let session = try makeSession(subject: "account")
        let otherAccount = try makeSession(subject: "other-account")
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let baseURL = server.url("/control/")
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        let controller = DashboardWindowController(
            url: baseURL,
            auth: auth,
            websiteDataStore: store.dataStore,
            tlsParams: GatewayTLSParams(
                required: true,
                expectedFingerprint: SHA256.hash(data: tls.certificate).map { String(format: "%02x", $0) }.joined(),
                allowTOFU: false,
                storeKey: nil),
            browserSessionLease: store.lease(for: session),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let observer = DashboardSignInNavigationObserver(controller: controller)
        controller.webView.navigationDelegate = observer
        try await observer.navigate { controller.show(url: baseURL, auth: auth) }
        _ = try await controller.webView.evaluateJavaScript(
            "history.replaceState({}, '', '/control/chat/fixture?view=thread')")
        let chatURL = try #require(controller.webView.url)

        // Close synchronously after admission, before the sign-in task can
        // access the profile catalog or start a browser helper.
        controller.reconnectGateway(.profile("fixture"))
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: baseURL) == chatURL)
        #expect(controller.browserSignInReturnURL(session: otherAccount, dashboardURL: baseURL) == nil)
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: server.url("/other/")) == nil)
        controller.closeDashboard()
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: baseURL) == nil)
    }
}
