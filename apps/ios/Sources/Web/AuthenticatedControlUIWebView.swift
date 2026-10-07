import Foundation
import Observation
import OpenClawKit
import SwiftUI
import WebKit

/// URL, credential, and WebView plumbing shared by authenticated Control UI pages.
enum AuthenticatedControlUI {
    struct StoredOperatorAuthorization {
        let identity: DeviceIdentity
        let entry: DeviceAuthEntry
    }

    private static let queryComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static let pathSegmentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!'()*")

    static func pageURL(
        config: GatewayConnectConfig?,
        path: String,
        queryItems: [URLQueryItem]) -> URL?
    {
        guard let config,
              var components = URLComponents(url: config.url, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "wss", "https":
            components.scheme = "https"
        default:
            components.scheme = "http"
        }
        components.percentEncodedPath = self.pagePath(basePath: components.percentEncodedPath, path: path)
        components.fragment = nil
        let encodedItems = queryItems.compactMap { item -> String? in
            guard let name = Self.percentEncodedQueryComponent(item.name) else { return nil }
            guard let value = item.value else { return name }
            guard let encodedValue = Self.percentEncodedQueryComponent(value) else { return nil }
            return "\(name)=\(encodedValue)"
        }
        guard encodedItems.count == queryItems.count else { return nil }
        components.percentEncodedQuery = encodedItems.isEmpty
            ? nil
            : encodedItems.joined(separator: "&")
        return components.url
    }

    static func percentEncodedPathSegment(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: self.pathSegmentAllowed)
    }

    /// Origin-gated document-start script for the Control UI native-auth contract.
    static func authUserScript(
        config: GatewayConnectConfig?,
        pageURL: URL?,
        storedOperatorToken: String?,
        usesNativeNavigationChrome: Bool = false) -> String?
    {
        guard let config, let pageURL else { return nil }
        var payload: [String: Any] = ["gatewayUrl": config.url.absoluteString]
        let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let password = config.password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let storedToken = storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let usesNativeConnectAuth = Self.storedOperatorAuthorization(
            config: config,
            expectedToken: storedToken) != nil
        if usesNativeConnectAuth {
            // The app signs challenges natively; the page never receives the device key or token.
            // Released UIs still read the shared fields, and a password must outrank a token.
            payload["nativeConnectAuth"] = true
            if !password.isEmpty {
                payload["password"] = password
                payload["token"] = NSNull()
            } else if !token.isEmpty {
                payload["token"] = token
            }
        } else {
            if !token.isEmpty { payload["token"] = token }
            if !password.isEmpty { payload["password"] = password }
        }
        guard usesNativeConnectAuth || payload["token"] != nil || payload["password"] != nil else {
            return nil
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        let allowedOrigin = Self.jsStringLiteral(Self.originString(for: pageURL))
        return """
        (() => {
          try {
            if (location.origin !== \(allowedOrigin)) return;
            if (\(usesNativeNavigationChrome)) {
              Object.defineProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__", {
                value: true,
                configurable: true,
              });
            }
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: \(json),
              configurable: true,
            });
          } catch {}
        })();
        """
    }

    /// Present exactly when `authUserScript` selects `nativeConnectAuth` for this token.
    @MainActor
    static func nativeAuthHandler(
        config: GatewayConnectConfig?,
        storedOperatorToken: String?) -> ControlUINativeGatewayAuthHandler?
    {
        let token = storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let config, !token.isEmpty,
              Self.storedOperatorAuthorization(config: config, expectedToken: token) != nil
        else { return nil }
        return ControlUINativeGatewayAuthHandler(config: config, expectedToken: token)
    }

    static func storedOperatorToken(config: GatewayConnectConfig?) -> String? {
        self.storedOperatorAuthorization(config: config)?.entry.token
    }

    static func webContentIdentity(config: GatewayConnectConfig?, storedOperatorToken: String?) -> Int {
        var hasher = Hasher()
        hasher.combine(config?.controlUIInputs)
        hasher.combine(storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines))
        return hasher.finalize()
    }

    private static func percentEncodedQueryComponent(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: self.queryComponentAllowed)
    }

    private static func originString(for url: URL) -> String {
        GatewayTLSAuthority(url: url)?.serialized ?? ""
    }

    private static func jsStringLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let raw = String(data: data, encoding: .utf8),
              raw.hasPrefix("["),
              raw.hasSuffix("]")
        else {
            return "\"\""
        }
        return String(raw.dropFirst().dropLast())
    }

    static func storedOperatorAuthorization(
        config: GatewayConnectConfig?,
        expectedToken: String? = nil) -> StoredOperatorAuthorization?
    {
        guard let config else { return nil }
        // Endpoint handoffs may explicitly suppress device-token reuse; every auth surface
        // must honor that boundary or a stale token can override the supplied password.
        guard config.nodeOptions.includeDeviceIdentity,
              config.nodeOptions.allowStoredDeviceAuth
        else { return nil }
        let profile = config.nodeOptions.deviceIdentityProfile
        let gatewayID = config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: profile),
              let entry = DeviceAuthStore.loadToken(
                  deviceId: identity.deviceId,
                  role: "operator",
                  gatewayID: gatewayID,
                  profile: profile)
        else { return nil }
        if let expectedToken,
           entry.token.trimmingCharacters(in: .whitespacesAndNewlines) != expectedToken
        {
            return nil
        }
        return StoredOperatorAuthorization(identity: identity, entry: entry)
    }

    private static func pagePath(basePath rawPath: String, path: String) -> String {
        let withLeadingSlash = rawPath.isEmpty || rawPath.hasPrefix("/") ? rawPath : "/" + rawPath
        let basePath = withLeadingSlash.isEmpty || withLeadingSlash == "/"
            ? "/"
            : withLeadingSlash.hasSuffix("/") ? withLeadingSlash : withLeadingSlash + "/"
        let relativePath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return relativePath.isEmpty ? basePath : basePath + relativePath
    }
}

@MainActor
enum AuthenticatedControlUIWebViewNavigationDecision: Equatable {
    case allow
    case cancel
    case cancelAndExitScope
}

@MainActor
@Observable
final class DashboardEmbedCompatibility {
    private var documentID: UUID?
    private var receivedStatus = false
    private var hasEmbedMarker = false
    private var deadlineReached = false
    @ObservationIgnored private var deadlineTask: Task<Void, Never>?
    @ObservationIgnored private var markerTask: Task<Void, Never>?
    @ObservationIgnored private weak var loadedWebView: WKWebView?

    var needsGatewayUpgrade: Bool {
        self.deadlineReached && !(self.receivedStatus && self.hasEmbedMarker)
    }

    func beginDocument() -> UUID {
        self.cancelChecks()
        let id = UUID()
        self.documentID = id
        self.receivedStatus = false
        self.hasEmbedMarker = false
        self.deadlineReached = false
        return id
    }

    func didReceiveStatusRequest() {
        guard let documentID else { return }
        self.receivedStatus = true
        if let loadedWebView {
            self.probeEmbedMarker(documentID: documentID, in: loadedWebView)
        }
    }

    func didFinishLoading(documentID: UUID, in webView: WKWebView) {
        guard self.documentID == documentID else { return }
        self.loadedWebView = webView
        self.probeEmbedMarker(documentID: documentID, in: webView)
        self.deadlineTask?.cancel()
        self.deadlineTask = Task { [weak self, weak webView] in
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.documentID == documentID else { return }
            // A stalled web process must not prevent the native upgrade guidance from appearing.
            self.deadlineReached = true
            if let webView {
                self.probeEmbedMarker(documentID: documentID, in: webView)
            }
        }
    }

    func retireDocument(_ documentID: UUID) {
        guard self.documentID == documentID else { return }
        self.cancelChecks()
        self.documentID = nil
        self.receivedStatus = false
        self.hasEmbedMarker = false
        self.deadlineReached = false
    }

    private func probeEmbedMarker(documentID: UUID, in webView: WKWebView) {
        self.markerTask?.cancel()
        self.markerTask = Task { [weak self, weak webView] in
            guard let webView else { return }
            let marker = try? await webView.evaluateJavaScript(
                "document.querySelector('.openclaw-native-embed') !== null")
            guard !Task.isCancelled, let self, self.documentID == documentID else { return }
            self.hasEmbedMarker = marker as? Bool == true
        }
    }

    private func cancelChecks() {
        self.deadlineTask?.cancel()
        self.deadlineTask = nil
        self.markerTask?.cancel()
        self.markerTask = nil
        self.loadedWebView = nil
    }
}

@MainActor
final class AuthenticatedControlUIWebViewCoordinator: NSObject, WKNavigationDelegate {
    let deviceSettingsBridge: IOSDeviceSettingsBridge?
    private let embedCompatibility: DashboardEmbedCompatibility?
    private var compatibilityDocumentID: UUID?
    private let url: URL
    private let authScript: String?
    private let usesNativeEmbed: Bool
    private let expectedOrigin: GatewayTLSAuthority?
    private let allowedMainFramePathPrefix: String?
    private let onMainFrameNavigationOutsideScope: (() -> Void)?
    private let tls: GatewayTLSParams?
    private var hasExitedNavigationScope = false
    private var activeNavigation: WKNavigation?

    init(
        url: URL,
        tls: GatewayTLSParams?,
        allowedMainFramePathPrefix: String? = nil,
        onMainFrameNavigationOutsideScope: (() -> Void)? = nil,
        authScript: String? = nil,
        deviceSettingsBridge: IOSDeviceSettingsBridge? = nil,
        usesNativeEmbed: Bool = false,
        embedCompatibility: DashboardEmbedCompatibility? = nil)
    {
        self.url = url
        self.authScript = authScript
        self.deviceSettingsBridge = deviceSettingsBridge
        self.usesNativeEmbed = usesNativeEmbed
        self.embedCompatibility = embedCompatibility
        self.expectedOrigin = GatewayTLSAuthority(url: url)
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix.map(Self.normalizedPath)
        self.onMainFrameNavigationOutsideScope = onMainFrameNavigationOutsideScope
        self.tls = tls
    }

    func installUserScripts(in controller: WKUserContentController) {
        controller.removeAllUserScripts()
        let embedScript = self.usesNativeEmbed ? Self.embedScript(url: self.url) : nil
        for script in [self.authScript, embedScript, self.deviceSettingsBridge?.seedScript(for: self.url)] {
            guard let script else { continue }
            controller.addUserScript(WKUserScript(
                source: script,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        }
    }

    static func embedScript(url: URL, isPad: Bool = UIDevice.current.userInterfaceIdiom == .pad) -> String? {
        let formFactor = isPad ? "pad" : "phone"
        return IOSDeviceSettingsBridge.originGatedScript(
            "window.__OPENCLAW_NATIVE_EMBED__ = { platform: 'ios', formFactor: '\(formFactor)' };", url: url)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        self.activeNavigation = navigation
        self.deviceSettingsBridge?.willNavigate(in: webView)
        self.installUserScripts(in: webView.configuration.userContentController)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard self.activeNavigation === navigation else { return }
        // WebKit retains the previous committed page when a provisional navigation fails.
        self.compatibilityDocumentID = self.embedCompatibility?.beginDocument()
        self.deviceSettingsBridge?.didCommitDocument(in: webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard self.activeNavigation === navigation, let compatibilityDocumentID else { return }
        self.embedCompatibility?.didFinishLoading(documentID: compatibilityDocumentID, in: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError _: any Error) {
        guard self.activeNavigation === navigation else { return }
        self.retireEmbedCompatibility()
        self.deviceSettingsBridge?.retireDocument(in: webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError _: any Error) {
        guard self.activeNavigation === navigation else { return }
        self.deviceSettingsBridge?.didFailProvisionalNavigation(in: webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        self.activeNavigation = nil
        self.retireEmbedCompatibility()
        self.deviceSettingsBridge?.retireDocument(in: webView)
    }

    func retireEmbedCompatibility() {
        guard let compatibilityDocumentID else { return }
        self.embedCompatibility?.retireDocument(compatibilityDocumentID)
        self.compatibilityDocumentID = nil
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        let decision = self.navigationDecision(
            to: navigationAction.request.url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame)
        decisionHandler(decision == .allow ? .allow : .cancel)
        if decision == .cancelAndExitScope, !self.hasExitedNavigationScope {
            self.hasExitedNavigationScope = true
            self.onMainFrameNavigationOutsideScope?()
        }
    }

    func webView(
        _: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let tls
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard self.matchesExpectedAuthority(
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port)
        else {
            // Cross-origin main-frame loads are already cancelled by navigation policy.
            // Other authorities may belong to embedded content and do not inherit the Gateway pin.
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
            params: tls)
        {
        case .accept:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func navigationDecision(
        to candidateURL: URL?,
        isMainFrame: Bool?) -> AuthenticatedControlUIWebViewNavigationDecision
    {
        if isMainFrame == false {
            return .allow
        }
        guard isMainFrame == true, let candidateURL else { return .cancel }
        guard GatewayTLSAuthority(url: candidateURL) == self.expectedOrigin else { return .cancel }
        guard let allowedMainFramePathPrefix else { return .allow }
        let candidatePath = Self.normalizedPath(candidateURL.path)
        guard allowedMainFramePathPrefix != "/" else { return .allow }
        return candidatePath == allowedMainFramePathPrefix ||
            candidatePath.hasPrefix(allowedMainFramePathPrefix + "/")
            ? .allow
            : .cancelAndExitScope
    }

    func matchesExpectedAuthority(host: String, port: Int) -> Bool {
        self.expectedOrigin?.matches(host: host, port: port) == true
    }

    private static func normalizedPath(_ path: String) -> String {
        var segments: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch segment {
            case ".":
                continue
            case "..":
                if !segments.isEmpty {
                    segments.removeLast()
                }
            default:
                segments.append(segment)
            }
        }
        return "/" + segments.joined(separator: "/")
    }
}

/// Ephemeral, script-hardened WKWebView for a self-contained Control UI page.
struct AuthenticatedControlUIWebView: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme

    let url: URL
    let authScript: String?
    let tls: GatewayTLSParams?
    let allowedMainFramePathPrefix: String?
    let onMainFrameNavigationOutsideScope: (() -> Void)?
    let deviceSettingsBridge: IOSDeviceSettingsBridge?
    let nativeAuth: ControlUINativeGatewayAuthHandler?
    let usesNativeEmbed: Bool
    let embedCompatibility: DashboardEmbedCompatibility?

    init(
        url: URL,
        authScript: String?,
        tls: GatewayTLSParams?,
        allowedMainFramePathPrefix: String? = nil,
        onMainFrameNavigationOutsideScope: (() -> Void)? = nil,
        deviceSettingsBridge: IOSDeviceSettingsBridge? = nil,
        nativeAuth: ControlUINativeGatewayAuthHandler? = nil,
        usesNativeEmbed: Bool = false,
        embedCompatibility: DashboardEmbedCompatibility? = nil)
    {
        self.url = url
        self.authScript = authScript
        self.nativeAuth = nativeAuth
        self.tls = tls
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix
        self.onMainFrameNavigationOutsideScope = onMainFrameNavigationOutsideScope
        self.deviceSettingsBridge = deviceSettingsBridge
        self.usesNativeEmbed = usesNativeEmbed
        self.embedCompatibility = embedCompatibility
    }

    func makeCoordinator() -> AuthenticatedControlUIWebViewCoordinator {
        AuthenticatedControlUIWebViewCoordinator(
            url: self.url,
            tls: self.tls,
            allowedMainFramePathPrefix: self.allowedMainFramePathPrefix,
            onMainFrameNavigationOutsideScope: self.onMainFrameNavigationOutsideScope,
            authScript: self.authScript,
            deviceSettingsBridge: self.deviceSettingsBridge,
            usesNativeEmbed: self.usesNativeEmbed,
            embedCompatibility: self.embedCompatibility)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        context.coordinator.installUserScripts(in: configuration.userContentController)
        if let deviceSettingsBridge {
            configuration.userContentController.addScriptMessageHandler(
                deviceSettingsBridge, contentWorld: .page, name: IOSDeviceSettingsBridge.messageHandlerName)
        }

        if let nativeAuth {
            configuration.userContentController.addScriptMessageHandler(
                nativeAuth, contentWorld: .page, name: ControlUINativeGatewayAuthHandler.name)
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        self.nativeAuth?.webView = webView
        self.deviceSettingsBridge?.attach(to: webView) { [weak coordinator = context.coordinator, weak webView] in
            guard let coordinator, let webView else { return }
            coordinator.installUserScripts(in: webView.configuration.userContentController)
        }
        self.applyAppearance(to: webView)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = true
        webView.backgroundColor = .black
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = true

        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.verticalScrollIndicatorInsets = .zero
        scrollView.horizontalScrollIndicatorInsets = .zero
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false

        webView.load(URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context _: Context) {
        self.applyAppearance(to: webView)
        // Connection changes recreate the view via `.id`; unrelated SwiftUI passes must not reload it.
    }

    private func applyAppearance(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = self.colorScheme == .dark ? .dark : .light
    }

    static func dismantleUIView(
        _ webView: WKWebView,
        coordinator: AuthenticatedControlUIWebViewCoordinator)
    {
        coordinator.retireEmbedCompatibility()
        coordinator.deviceSettingsBridge?.detach(from: webView)
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: IOSDeviceSettingsBridge.messageHandlerName, contentWorld: .page)
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: ControlUINativeGatewayAuthHandler.name, contentWorld: .page)
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
