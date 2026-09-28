import AppKit
import Foundation
import OpenClawKit
import WebKit

enum DashboardBrowserResponseAction: Equatable {
    case allow
    case openExternal(URL)
    case cancel
}

extension ControlUIDocumentHost {
    static func appPath(fromDocumentPath path: String, baseURL: URL) -> String? {
        guard DashboardRouteMap.isValidSameAppPath(path) else { return nil }
        let mount = self.allowedPath(for: baseURL)
        guard mount != "/" else { return path }
        guard path.hasPrefix(mount) else { return nil }
        return "/" + path.dropFirst(mount.count)
    }

    static func isTrustedLinkSource(_ sourceURL: URL?, dashboardURL: URL) -> Bool {
        guard let sourceURL, sameOrigin(sourceURL, dashboardURL) else { return false }
        let allowedPath = Self.allowedPath(for: dashboardURL)
        return allowedPath == "/" || sourceURL.path(percentEncoded: true).hasPrefix(allowedPath)
    }

    static func shouldAllowEditorURLLaunch(
        from sourceURL: URL?,
        isMainFrame: Bool,
        dashboardURL: URL) -> Bool
    {
        isMainFrame && self.isTrustedLinkSource(sourceURL, dashboardURL: dashboardURL)
    }

    static func isHTTPURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else {
            return false
        }
        return true
    }

    static func isExternalURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" {
            return self.isHTTPURL(url)
        }
        return scheme == "mailto" || scheme == "tel"
    }

    static func isEditorURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              url.host?.lowercased() == "file",
              !url.path.isEmpty
        else {
            return false
        }
        return scheme == "cursor" || scheme == "vscode" || scheme == "windsurf" || scheme == "zed"
    }

    static func shouldAllowNavigation(
        to url: URL,
        dashboardURL: URL,
        isMainFrame: Bool) -> Bool
    {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            return true
        }
        guard scheme == "http" || scheme == "https", url.user == nil, url.password == nil else { return false }
        if self.sameOrigin(url, dashboardURL) {
            return true
        }
        // Website widgets are sandboxed by the Control UI and receive no native
        // bridge. Let their documents, links, and nested frames behave like they
        // do in a browser without allowing them to replace the dashboard.
        return !isMainFrame && url.host?.isEmpty == false
    }

    static func shouldAllowBrowserNavigation(to url: URL, isMainFrame: Bool) -> Bool {
        if isMainFrame {
            return self.isHTTPURL(url)
        }
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "about" || scheme == "blob" || scheme == "data" || self.isHTTPURL(url)
    }

    static func browserResponseAction(
        for url: URL?,
        canShowMIMEType: Bool,
        isMainFrame: Bool,
        userActivated: Bool) -> DashboardBrowserResponseAction
    {
        if canShowMIMEType { return .allow }
        if isMainFrame, userActivated, let url, self.isHTTPURL(url) { return .openExternal(url) }
        return .cancel
    }

    static func shouldAllowIdentityNavigation(
        to url: URL,
        auth: DashboardWindowAuth,
        isMainFrame: Bool,
        sourceIsDashboard: Bool,
        navigationType: WKNavigationType) -> Bool
    {
        guard auth.usesBrowserIdentity, url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return false }
        // Dashboard links keep their browser handoff. Redirects and the identity
        // provider's links/forms stay here so its cookies authenticate the returning page.
        return sourceIsDashboard ? isMainFrame && navigationType != .linkActivated : true
    }

    static func shouldOpenExternalDashboardNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int) -> Bool
    {
        // WebKit also labels synthetic anchor.click() as linkActivated. Its
        // action reports button 0; a physical primary click reports 1 here.
        navigationType == .linkActivated && buttonNumber > 0 && self.isExternalURL(url)
    }

    static func shouldHandleAppLinkNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        sourceURL: URL?,
        sourceIsMainFrame: Bool,
        dashboardURL: URL) -> Bool
    {
        sourceIsMainFrame && self.isTrustedLinkSource(sourceURL, dashboardURL: dashboardURL) &&
            navigationType == .linkActivated && buttonNumber > 0 && DeepLinkParser.parse(url) != nil
    }

    static func targetlessNavigationAction(
        for url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool) -> DashboardTargetlessNavigationAction
    {
        if self.isHTTPURL(url) {
            return .allow
        }
        // The trusted Control UI's file sidebar opens these explicit editor URLs
        // with window.open(); never grant the same synthetic-launch path to web content.
        if allowEditorURLs, self.isEditorURL(url) {
            return .openExternal
        }
        if self.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationType,
            buttonNumber: buttonNumber)
        {
            return .openExternal
        }
        return .cancel
    }

    static func newWindowAction(for url: URL?, sourceIsNativeReadingTab: Bool) -> DashboardNewWindowAction {
        guard let url, self.isHTTPURL(url) else { return .ignore }
        return sourceIsNativeReadingTab ? .openTab(url) : .openExternal(url)
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        self.isHTTPURL(lhs) && self.isHTTPURL(rhs) &&
            self.originString(for: lhs) == self.originString(for: rhs)
    }

    static func isTrustedMediaCaptureOrigin(
        protocol scheme: String,
        host: String,
        port: Int,
        dashboardURL: URL) -> Bool
    {
        guard scheme.caseInsensitiveCompare(dashboardURL.scheme ?? "") == .orderedSame,
              host.caseInsensitiveCompare(dashboardURL.host ?? "") == .orderedSame
        else {
            return false
        }
        let requestedPort = port == 0 ? Self.defaultPort(for: scheme) : port
        let dashboardPort = dashboardURL.port ?? Self.defaultPort(for: dashboardURL.scheme)
        return requestedPort == dashboardPort
    }

    static func defaultPort(for scheme: String?) -> Int? {
        switch scheme?.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}

extension ControlUIDocumentHost {
    func decidePolicy(
        for navigationAction: WKNavigationAction,
        documentReady: Bool,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame == nil {
            let allowEditorURLs = ControlUIDocumentHost.shouldAllowEditorURLLaunch(
                from: navigationAction.sourceFrame.request.url,
                isMainFrame: navigationAction.sourceFrame.isMainFrame,
                dashboardURL: self.currentURL)
            self.decideTargetlessNavigation(
                url,
                navigationType: navigationAction.navigationType,
                buttonNumber: navigationAction.buttonNumber,
                allowEditorURLs: allowEditorURLs,
                decisionHandler: decisionHandler)
            return
        }
        if ControlUIDocumentHost.shouldAllowIdentityNavigation(
            to: url,
            auth: self.auth,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
            sourceIsDashboard: ControlUIDocumentHost.isTrustedLinkSource(
                self.webView.url,
                dashboardURL: self.currentURL) &&
                (!self.auth.usesBrowserIdentity || documentReady),
            navigationType: navigationAction.navigationType)
        {
            decisionHandler(.allow)
            return
        }
        if ControlUIDocumentHost.shouldAllowNavigation(
            to: url,
            dashboardURL: self.currentURL,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true)
        {
            decisionHandler(.allow)
            return
        }
        // Back/forward can reach entries from a previous gateway endpoint after
        // a tunnel/port swap; opening those externally would launch a dead URL
        // in the browser, so swallow the traversal instead.
        if navigationAction.navigationType == .backForward {
            decisionHandler(.cancel)
            return
        }
        if ControlUIDocumentHost.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationAction.navigationType,
            buttonNumber: navigationAction.buttonNumber)
        {
            self.openExternal(url)
        }
        decisionHandler(.cancel)
    }

    func decideTargetlessNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        switch ControlUIDocumentHost.targetlessNavigationAction(
            for: url,
            navigationType: navigationType,
            buttonNumber: buttonNumber,
            allowEditorURLs: allowEditorURLs)
        {
        case .allow:
            decisionHandler(.allow)
        case .openExternal:
            self.openExternal(url)
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    private func openExternal(_ url: URL) {
        guard Self.isExternalURL(url) || Self.isEditorURL(url) else { return }
        NSWorkspace.shared.open(url)
    }
}
