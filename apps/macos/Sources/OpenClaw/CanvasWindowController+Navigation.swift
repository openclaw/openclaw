import AppKit
import WebKit

extension CanvasWindowController {
    // MARK: - WKNavigationDelegate

    @MainActor
    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased()
        // Deep links: allow local Canvas content to invoke the agent without bouncing through NSWorkspace.
        if scheme == "openclaw" {
            if self.webView.url?.scheme == CanvasScheme.scheme {
                Task { await DeepLinkHandler.shared.handle(url: url) }
            } else {
                canvasWindowLogger.debug("ignoring deep link from non-canvas page")
            }
            decisionHandler(.cancel)
            return
        }

        // Keep web content inside the panel when reasonable.
        // `about:blank` and friends are common internal navigations for WKWebView; never send them to NSWorkspace.
        if scheme == CanvasScheme.scheme
            || scheme == "https"
            || scheme == "http"
            || scheme == "about"
            || scheme == "blob"
            || scheme == "data"
            || scheme == "javascript"
        {
            decisionHandler(.allow)
            return
        }

        // Only open external URLs when there is a registered handler, otherwise macOS will show a confusing
        // "There is no application set to open the URL ..." alert (e.g. for about:blank).
        if let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) {
            AppActivation.shared.open([url], withApplicationAt: appURL)
        } else {
            canvasWindowLogger.debug("no application to open scheme=\(scheme ?? "-", privacy: .public)")
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didCommit _: WKNavigation?) {
        if let url = webView.url {
            self.updateFilePollingForCommittedNavigation(to: url)
        }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        self.applyDebugStatusIfNeeded()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error)
    {
        self.webView(webView, didFail: navigation, withError: error)
    }

    func webView(_: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        // A newer load superseding this one is not a failure, and WebKit reports PDFs it hands to its
        // plug-in (WebKitErrorDomain 204, "Plug-in handled load") through this callback while they display.
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain", nsError.code == 204 { return }
        canvasWindowLogger.error(
            "canvas load failed domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
        // The system's description goes into HTML, so escape it; the code stays in the log above.
        let reason = nsError.localizedDescription
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        self.showLoadFailure(
            "Canvas couldn't show this page: \(reason). Check the file or URL, then present it again.")
    }

    func webViewWebContentProcessDidTerminate(_: WKWebView) {
        canvasWindowLogger.error("canvas web content process terminated")
        // A failure page instead of reload: a crash that recurs on load would loop.
        self.showLoadFailure("Canvas stopped unexpectedly. Present it again to retry.")
    }

    private func showLoadFailure(_ message: String) {
        let page = CanvasSchemeHandler.html(message, title: "Canvas error")
        self.webView.load(
            page.data,
            mimeType: page.mime,
            characterEncodingName: "utf-8",
            baseURL: URL(string: "about:blank")!)
    }
}
