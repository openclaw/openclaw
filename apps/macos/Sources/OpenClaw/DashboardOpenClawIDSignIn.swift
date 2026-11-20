import AppKit
import Foundation
import WebKit

/// Presents only the login. The Gateway still owns PKCE and token redemption, and the
/// requesting Control UI document owns the resulting account. Native claw enrollment is separate.
@MainActor
final class DashboardOpenClawIDSignIn: NSObject, WKScriptMessageHandlerWithReply,
    WKNavigationDelegate, WKUIDelegate, NSWindowDelegate
{
    static let name = "openclawIdSignIn"
    typealias Reply = @MainActor (Any?, String?) -> Void

    weak var owner: DashboardWindowController?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var pending: (redirect: URL, state: String, reply: Reply)?
    private var timeout: Task<Void, Never>?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping Reply)
    {
        guard let owner, message.name == Self.name, message.world === WKContentWorld.page,
              message.webView === owner.webView, message.frameInfo.isMainFrame,
              owner.isWindowOpen, owner.canDeliverNativeCommands,
              owner.documentHost.hasCurrentBrowserSession,
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: owner.currentURL),
              let parent = owner.window,
              let body = message.body as? [String: Any], let rawURL = body["authorizationUrl"] as? String,
              let authorization = URL(string: rawURL), ControlUIDocumentHost.isHTTPURL(authorization),
              authorization.user == nil, authorization.password == nil,
              let query = URLComponents(url: authorization, resolvingAgainstBaseURL: false)?.queryItems,
              query.filter({ $0.name == "state" }).count == 1,
              let state = query.first(where: { $0.name == "state" })?.value, !state.isEmpty,
              query.filter({ $0.name == "redirect_uri" }).count == 1,
              let rawRedirect = query.first(where: { $0.name == "redirect_uri" })?.value,
              let redirect = URL(string: rawRedirect), redirect.query == nil, redirect.fragment == nil,
              redirect.user == nil, redirect.password == nil,
              ControlUIDocumentHost.isTrustedLinkSource(redirect, dashboardURL: owner.currentURL),
              ControlUIDocumentHost.appPath(fromDocumentPath: redirect.path, baseURL: owner.currentURL) ==
              "/openclaw-id/callback"
        else {
            replyHandler(nil, "Sign-in did not finish. Try again.")
            return
        }
        // A second click replaces the previous presentation, rather than leaving two pending accounts.
        self.cancel()
        self.pending = (redirect, state, replyHandler)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = owner.webView.configuration.websiteDataStore
        // Do not copy the dashboard's user scripts or native message handlers into issuer pages.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        self.webView = webView
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 720),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "OpenClaw ID"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        self.window = window
        parent.addChildWindow(window, ordered: .above)
        window.setFrameOrigin(NSPoint(
            x: parent.frame.midX - window.frame.width / 2,
            y: parent.frame.midY - window.frame.height / 2))
        WindowPlacement.ensureOnScreen(window: window, defaultSize: NSSize(width: 520, height: 720))
        AppActivation.shared.makeKeyAndOrderFront(window: window)
        window.makeFirstResponder(webView)
        webView.load(URLRequest(url: authorization))
        self.timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(600)) } catch { return }
            self?.finish(error: "Sign-in timed out. Try again.")
        }
    }

    func cancel() {
        self.finish(error: "Sign-in was cancelled.")
    }

    private func finish(result: [String: Any]? = nil, error: String? = nil) {
        guard let pending = self.pending else { return }
        self.pending = nil
        self.timeout?.cancel()
        self.timeout = nil
        self.webView?.stopLoading()
        self.webView?.navigationDelegate = nil
        self.webView?.uiDelegate = nil
        self.webView = nil
        let window = self.window
        self.window = nil
        window?.delegate = nil
        if let window { window.parent?.removeChildWindow(window) }
        window?.close()
        pending.reply(result, error)
    }

    func windowWillClose(_: Notification) {
        self.cancel()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard webView === self.webView, let pending = self.pending, let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame?.isMainFrame == true,
           url.scheme == pending.redirect.scheme, url.host == pending.redirect.host,
           url.port == pending.redirect.port, url.path == pending.redirect.path
        {
            decisionHandler(.cancel)
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard query.filter({ $0.name == "state" }).count == 1,
                  query.first(where: { $0.name == "state" })?.value == pending.state
            else {
                self.finish(error: "Sign-in did not finish. Try again.")
                return
            }
            let code = query.first(where: { $0.name == "code" })?.value
            let error = query.first(where: { $0.name == "error" })?.value
            guard code?.isEmpty == false || error?.isEmpty == false else {
                self.finish(error: "Sign-in did not finish. Try again.")
                return
            }
            self.finish(result: [
                "state": pending.state,
                "code": code.map { $0 as Any } ?? NSNull(),
                "error": error.map { $0 as Any } ?? NSNull(),
            ])
            return
        }
        // Issuer pages can follow their identity-provider redirects, but never launch local apps/files.
        let allowed = ControlUIDocumentHost.shouldAllowBrowserNavigation(
            to: url, isMainFrame: action.targetFrame?.isMainFrame != false)
        decisionHandler(allowed ? .allow : .cancel)
        if !allowed, action.targetFrame?.isMainFrame == true {
            self.finish(error: "Sign-in did not finish. Try again.")
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures _: WKWindowFeatures) -> WKWebView?
    {
        // Keep identity-provider target=_blank links in this unprivileged sign-in window.
        if webView === self.webView, let url = action.request.url, ControlUIDocumentHost.isHTTPURL(url) {
            webView.load(action.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        if webView === self.webView { self.window?.subtitle = webView.url?.host ?? "" }
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === self.webView { self.cancel() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) {
        if webView === self.webView { self.finish(error: "Sign-in did not finish. Try again.") }
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError _: Error) {
        if webView === self.webView { self.finish(error: "Sign-in did not finish. Try again.") }
    }
}
