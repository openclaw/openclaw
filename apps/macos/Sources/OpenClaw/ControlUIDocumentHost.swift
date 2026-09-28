import AppKit
import Foundation
import OpenClawKit
import WebKit

/// Document lifetime and trust belong here; each presentation installs only its own capabilities.
@MainActor
final class ControlUIDocumentHost {
    let webView: DashboardWebView
    var currentURL: URL
    var auth: DashboardWindowAuth
    let tlsParams: GatewayTLSParams?
    let browserSessionLease: DashboardBrowserSessionStore.Lease?
    private(set) var generation: UInt64 = 0
    var sourceID = UUID().uuidString
    var hasLiveContent = false
    var isShowingFailurePage = false
    private(set) var pendingLoad: Task<Void, Never>?
    private var loadGeneration: UInt64 = 0
    var isAvailable: () -> Bool = { true }
    var onAuthenticationFailure: ((Error) -> Void)?

    init(
        url: URL,
        auth: DashboardWindowAuth,
        websiteDataStore: WKWebsiteDataStore,
        tlsParams: GatewayTLSParams? = nil,
        browserSessionLease: DashboardBrowserSessionStore.Lease? = nil,
        installCapabilities: (WKUserContentController) -> Void)
    {
        self.currentURL = url
        self.auth = auth
        self.tlsParams = tlsParams
        self.browserSessionLease = browserSessionLease
        let config = WKWebViewConfiguration()
        config.websiteDataStore = websiteDataStore
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.tabFocusesLinks = true
        config.userContentController = WKUserContentController()
        installCapabilities(config.userContentController)
        Self.installNativeAuthScript(
            into: config.userContentController,
            url: url,
            auth: auth)
        self.webView = DashboardWebView(
            frame: NSRect(
                origin: .zero,
                size: DashboardWindowLayout.windowSize),
            configuration: config)
        // The initial WebKit canvas must not flash white before the document paints.
        self.webView.setValue(
            false,
            forKey: "drawsBackground")
        self.webView.underPageBackgroundColor = .windowBackgroundColor
        self.webView.allowsBackForwardNavigationGestures = true
        self.registerWindowChromeHandler()
        self.installWindowChromeScript()
    }

    var browserSession: GatewayBrowserSession? {
        self.browserSessionLease?.session
    }

    var hasCurrentBrowserSession: Bool {
        // Account changes revoke the lease before awaited WebKit cleanup replaces the document.
        guard self.browserSessionLease?.isCurrent != false else { return false }
        do {
            try self.browserSession?.validate(for: self.currentURL)
            return true
        } catch {
            return false
        }
    }

    func load(_ url: URL) {
        self.retirePendingLoad()
        self.hasLiveContent = false
        self.isShowingFailurePage = false
        let urlDescription = GatewayEndpointStore.diagnosticURLString(for: url)
        dashboardWindowLogger.debug("dashboard load \(urlDescription, privacy: .public)")
        guard let browserSessionLease else {
            self.webView.load(URLRequest(url: url))
            return
        }
        let generation = self.loadGeneration
        let controller = self.webView.configuration.userContentController
        self.pendingLoad = Task { @MainActor [weak self] in
            do {
                try await browserSessionLease.prepare(
                    for: url,
                    in: controller)
                guard let self, self.loadGeneration == generation, self.isAvailable() else { return }
                self.pendingLoad = nil
                self.webView.load(URLRequest(url: url))
            } catch {
                guard !Task.isCancelled, let self, self.loadGeneration == generation else { return }
                self.pendingLoad = nil
                self.onAuthenticationFailure?(error)
            }
        }
    }

    func retirePendingLoad() {
        self.loadGeneration &+= 1
        self.pendingLoad?.cancel()
        self.pendingLoad = nil
    }

    func retireDocument() {
        self.generation &+= 1
        self.sourceID = UUID().uuidString
        self.hasLiveContent = false
    }

    func committed() {
        self.retireDocument()
        if self.webView.url?.scheme?.lowercased().hasPrefix("http") == true {
            self.isShowingFailurePage = false
        }
    }

    func authenticationChallenge(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let params = self.tlsParams,
              Self.isExpectedTLSAuthority(
                  host: challenge.protectionSpace.host,
                  port: challenge.protectionSpace.port,
                  dashboardURL: self.currentURL)
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        switch GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port,
            params: params)
        {
        case .accept: completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject: completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    static func isExpectedTLSAuthority(
        host: String,
        port: Int,
        dashboardURL: URL) -> Bool
    {
        GatewayTLSAuthority(url: dashboardURL)?.matches(
            host: host,
            port: port) == true
    }
}
