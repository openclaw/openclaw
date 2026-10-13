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
    var nativeGatewayAuthProvider: DashboardNativeGatewayAuth.Provider? {
        didSet { self.nativeGatewayAuthRevision &+= 1 }
    }

    var legacyNativeCredentials: DashboardNativeGatewayAuth.LegacyCredentials? {
        didSet { self.observeNativeStartupCredentials() }
    }

    private(set) var nativeStartupObservation: Task<Void, Never>?
    private var nativeStartupRevision: UInt64 = 0
    var nativeAuthScript: WKUserScript?
    private(set) var nativeGatewayAuthRevision: UInt64 = 0
    let tlsParams: GatewayTLSParams?
    let browserSessionLease: DashboardBrowserSessionStore.Lease?
    private(set) var generation: UInt64 = 0
    var sourceID = UUID().uuidString
    var hasLiveContent = false
    var isShowingFailurePage = false
    private(set) var pendingLoad: Task<Void, Never>?
    private var loadGeneration: UInt64 = 0
    var isAvailable: () -> Bool = { true }
    // A retained document may outlive its presentation while WebKit stops it.
    var isNativeAuthAvailable: () -> Bool = { false }
    var onAuthenticationFailure: ((Error) -> Void)?

    init(
        url: URL,
        auth: DashboardWindowAuth,
        websiteDataStore: WKWebsiteDataStore,
        tlsParams: GatewayTLSParams? = nil,
        browserSessionLease: DashboardBrowserSessionStore.Lease? = nil,
        nativeAuthProvider: DashboardNativeGatewayAuth.Provider? = nil,
        legacyNativeCredentials: DashboardNativeGatewayAuth.LegacyCredentials? = nil,
        installCapabilities: (WKUserContentController) -> Void)
    {
        self.currentURL = url
        self.auth = auth
        self.tlsParams = tlsParams
        self.browserSessionLease = browserSessionLease
        self.nativeGatewayAuthProvider = nativeAuthProvider
        self.legacyNativeCredentials = legacyNativeCredentials
        let config = WKWebViewConfiguration()
        config.websiteDataStore = websiteDataStore
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.tabFocusesLinks = true
        config.userContentController = WKUserContentController()
        let nativeAuthHandler = ControlUINativeGatewayAuthMessageHandler()
        config.userContentController.addScriptMessageHandler(
            nativeAuthHandler, contentWorld: .page, name: ControlUINativeGatewayAuthMessageHandler.name)
        installCapabilities(config.userContentController)
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
        nativeAuthHandler.owner = self
        self.registerWindowChromeHandler()
        self.installWindowChromeScript()
        self.installNativeAuthScript()
        self.observeNativeStartupCredentials()
    }

    isolated deinit {
        self.nativeStartupObservation?.cancel()
    }

    var hasCurrentNativeStartupCredentials: Bool {
        self.retireInvalidNativeStartupCredentials()
        return self.auth.hasAcceptedNativeBinding
    }

    private func observeNativeStartupCredentials() {
        self.nativeStartupRevision &+= 1
        self.nativeStartupObservation?.cancel()
        self.nativeStartupObservation = nil
        self.retireInvalidNativeStartupCredentials()
        guard let credentials = self.legacyNativeCredentials,
              let waitForInvalidation = credentials.waitForInvalidation else { return }
        let revision = self.nativeStartupRevision
        self.nativeStartupObservation = Task { @MainActor [weak self] in
            await waitForInvalidation()
            guard !Task.isCancelled, let self, self.nativeStartupRevision == revision else { return }
            self.retireInvalidNativeStartupCredentials()
        }
    }

    private func retireInvalidNativeStartupCredentials() {
        guard let credentials = self.legacyNativeCredentials, !credentials.isCurrent(),
              case let .nativeDevice(gatewayUrl, token, password, accepted) = self.auth,
              accepted != nil else { return }
        // Retire only this projection, not the document, its route, or newer
        // navigation intent. The challenge provider can follow native reconnect.
        self.auth = .nativeDevice(gatewayUrl: gatewayUrl, token: token, password: password)
        self.nativeGatewayAuthRevision &+= 1
        self.installNativeAuthScript()
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
        self.retireInvalidNativeStartupCredentials()
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
