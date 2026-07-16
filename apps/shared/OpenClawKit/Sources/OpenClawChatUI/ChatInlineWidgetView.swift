import Foundation
import SwiftUI

#if canImport(WebKit) && (os(iOS) || os(macOS))
import WebKit
#endif

public enum OpenClawChatWidgetURLResolver {
    private static let documentsPath = "/__openclaw__/canvas/documents"

    public static func resolve(surfaceURL rawSurfaceURL: String?, target rawTarget: String) -> URL? {
        guard let target = self.relativeWidgetTarget(rawTarget),
              var surface = self.capabilitySurface(rawSurfaceURL)
        else { return nil }

        var surfacePath = surface.percentEncodedPath
        while surfacePath.hasSuffix("/") {
            surfacePath.removeLast()
        }
        surface.percentEncodedPath = surfacePath + target.percentEncodedPath
        surface.percentEncodedQuery = target.percentEncodedQuery
        surface.fragment = target.fragment
        return surface.url
    }

    public static func supportsTarget(_ rawTarget: String) -> Bool {
        self.relativeWidgetTarget(rawTarget) != nil
    }

    private static func relativeWidgetTarget(_ rawTarget: String) -> URLComponents? {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target.hasPrefix("/"),
              let components = URLComponents(string: target),
              components.scheme == nil,
              components.host == nil,
              components.user == nil,
              components.password == nil,
              self.isCanonicalPath(components.percentEncodedPath),
              components.percentEncodedPath.hasPrefix("\(self.documentsPath)/")
        else { return nil }
        return components
    }

    private static func capabilitySurface(_ rawSurfaceURL: String?) -> URLComponents? {
        let raw = rawSurfaceURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty,
              let components = URLComponents(string: raw),
              self.isWebURL(components),
              components.user == nil,
              components.password == nil,
              components.percentEncodedQuery == nil,
              components.fragment == nil
        else { return nil }

        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count >= 3,
              segments[segments.count - 3] == "__openclaw__",
              segments[segments.count - 2] == "cap",
              let capability = String(segments[segments.count - 1]).removingPercentEncoding,
              !capability.isEmpty
        else { return nil }
        return components
    }

    private static func isWebURL(_ components: URLComponents) -> Bool {
        let scheme = components.scheme?.lowercased()
        return (scheme == "http" || scheme == "https") && components.host?.isEmpty == false
    }

    private static func isCanonicalPath(_ path: String) -> Bool {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.first?.isEmpty == true else { return false }
        for (index, encodedSegment) in segments.enumerated() {
            if index == 0 || (index == segments.count - 1 && encodedSegment.isEmpty) {
                continue
            }
            guard !encodedSegment.isEmpty else { return false }
            guard let segment = self.decodeRepeatedly(String(encodedSegment)) else { return false }
            if segment == "." || segment == ".." || segment.contains("/") || segment.contains("\\") {
                return false
            }
        }
        return true
    }

    private static func decodeRepeatedly(_ encoded: String) -> String? {
        var value = encoded
        for _ in 0..<8 {
            guard let decoded = value.removingPercentEncoding else { return nil }
            if decoded == value { return decoded }
            value = decoded
        }
        return nil
    }
}

@MainActor
struct ChatInlineWidgetView: View {
    let preview: OpenClawChatCanvasPreview
    let resolverReady: Bool
    let resolveURL: @MainActor @Sendable (String, URL?) async -> URL?

    @State private var resolvedURL: URL?
    @State private var didRefresh = false
    @State private var refreshInFlight = false
    @State private var unavailable = false
    @State private var activePath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = self.preview.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                Text(title)
                    .font(OpenClawChatTypography.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(OpenClawChatTheme.muted)
            }

            #if canImport(WebKit) && (os(iOS) || os(macOS))
            if let resolvedURL {
                ChatInlineWidgetWebView(
                    url: resolvedURL,
                    allowsScripts: self.preview.sandbox == "scripts",
                    onFailure: { self.handleLoadFailure(url: resolvedURL) })
                    .id("\(resolvedURL.absoluteString)\u{0}\(self.preview.sandbox ?? "")")
                    .frame(height: self.preview.inlineWidgetHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(OpenClawChatTheme.muted.opacity(0.24), lineWidth: 1)
                    }
            } else if self.unavailable {
                Text("Widget unavailable")
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(OpenClawChatTheme.muted)
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            #else
            Text("Widget unavailable")
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(OpenClawChatTheme.muted)
            #endif
        }
        .task(id: LoadID(path: self.preview.inlineWidgetPath, resolverReady: self.resolverReady)) {
            let path = self.preview.inlineWidgetPath
            if self.activePath != path {
                self.reset(path: path)
            }
            guard self.resolverReady else { return }
            self.reset(path: path)
            guard let path else {
                self.unavailable = true
                return
            }
            await self.load(path: path, replacing: nil)
        }
    }

    private struct LoadID: Hashable {
        let path: String?
        let resolverReady: Bool
    }

    private func reset(path: String?) {
        self.activePath = path
        self.resolvedURL = nil
        self.didRefresh = false
        self.refreshInFlight = false
        self.unavailable = false
    }

    private func load(path: String, replacing failedURL: URL?) async {
        let url = await self.resolveURL(path, failedURL)
        guard !Task.isCancelled, self.activePath == path else { return }
        self.resolvedURL = url
        self.unavailable = url == nil
    }

    private func handleLoadFailure(url: URL) {
        guard self.resolvedURL == url,
              let path = self.activePath,
              !self.refreshInFlight
        else { return }
        guard !self.didRefresh else {
            self.resolvedURL = nil
            self.unavailable = true
            return
        }
        self.didRefresh = true
        self.refreshInFlight = true
        Task { @MainActor in
            await self.load(path: path, replacing: url)
            guard self.activePath == path else { return }
            self.refreshInFlight = false
        }
    }
}

#if canImport(WebKit) && (os(iOS) || os(macOS))
@MainActor
private final class ChatInlineWidgetNavigationDelegate: NSObject, WKNavigationDelegate {
    var expectedURL: URL
    let onFailure: @MainActor @Sendable () -> Void

    init(expectedURL: URL, onFailure: @escaping @MainActor @Sendable () -> Void) {
        self.expectedURL = expectedURL
        self.onFailure = onFailure
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.cancel)
            return
        }
        guard navigationAction.request.httpMethod?.caseInsensitiveCompare("GET") == .orderedSame,
              let url = navigationAction.request.url,
              self.matchesExpectedDocument(url)
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 400
        {
            self.onFailure()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation?, withError _: any Error) {
        self.onFailure()
    }

    func webView(_: WKWebView, didFail _: WKNavigation?, withError _: any Error) {
        self.onFailure()
    }

    private func matchesExpectedDocument(_ candidate: URL) -> Bool {
        guard var expected = URLComponents(url: self.expectedURL, resolvingAgainstBaseURL: false),
              var candidate = URLComponents(url: candidate, resolvingAgainstBaseURL: false)
        else { return false }
        expected.fragment = nil
        candidate.fragment = nil
        return expected == candidate
    }
}

@MainActor
private func makeChatInlineWidgetWebView(
    url: URL,
    allowsScripts: Bool,
    coordinator: ChatInlineWidgetNavigationDelegate) -> WKWebView
{
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsScripts
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.allowsLinkPreview = false
    webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    return webView
}

#if os(iOS)
private struct ChatInlineWidgetWebView: UIViewRepresentable {
    let url: URL
    let allowsScripts: Bool
    let onFailure: @MainActor @Sendable () -> Void

    func makeCoordinator() -> ChatInlineWidgetNavigationDelegate {
        ChatInlineWidgetNavigationDelegate(expectedURL: self.url, onFailure: self.onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        makeChatInlineWidgetWebView(
            url: self.url,
            allowsScripts: self.allowsScripts,
            coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.expectedURL != self.url else { return }
        context.coordinator.expectedURL = self.url
        webView.load(URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: ChatInlineWidgetNavigationDelegate) {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
#elseif os(macOS)
private struct ChatInlineWidgetWebView: NSViewRepresentable {
    let url: URL
    let allowsScripts: Bool
    let onFailure: @MainActor @Sendable () -> Void

    func makeCoordinator() -> ChatInlineWidgetNavigationDelegate {
        ChatInlineWidgetNavigationDelegate(expectedURL: self.url, onFailure: self.onFailure)
    }

    func makeNSView(context: Context) -> WKWebView {
        makeChatInlineWidgetWebView(
            url: self.url,
            allowsScripts: self.allowsScripts,
            coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.expectedURL != self.url else { return }
        context.coordinator.expectedURL = self.url
        webView.load(URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: ChatInlineWidgetNavigationDelegate) {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
#endif
#endif
