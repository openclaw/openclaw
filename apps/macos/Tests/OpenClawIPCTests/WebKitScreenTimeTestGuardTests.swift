import AppKit
import OpenClawWebKitTestSupport
import Testing
import WebKit

@MainActor
private final class ScreenTimeGuardNavigationObserver: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    func load(_ url: URL, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.load(URLRequest(url: url))
        }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation!) {
        self.continuation?.resume()
        self.continuation = nil
    }

    func webView(_: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }
}

@MainActor
struct WebKitScreenTimeTestGuardTests {
    @Test func `windowed HTTP web views never start Screen Time observation in tests`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
            styleMask: .borderless,
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        defer {
            webView.navigationDelegate = nil
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
        window.orderFrontRegardless()

        let observer = ScreenTimeGuardNavigationObserver()
        webView.navigationDelegate = observer
        try await observer.load(server.url("/"), in: webView)
        // Snapshots wait for the next presentation update, where WebKit runs its post-commit Screen Time hook.
        _ = try await webView.takeSnapshot(configuration: nil)

        #expect(
            OpenClawWebKitTestSupportDidSuppressScreenTime(webView),
            "WebKit's _installScreenTimeWebpageControllerIfNeeded hook is missing or was not called")
    }
}
