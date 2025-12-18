import ClawdisKit
import Observation
import SwiftUI
import WebKit

@MainActor
@Observable
final class ScreenController {
    enum Mode: Sendable {
        case canvas
        case web
    }

    let webView: WKWebView
    private let navigationDelegate: ScreenNavigationDelegate
    private let a2uiActionHandler: CanvasA2UIActionMessageHandler

    var urlString: String = ""
    var errorText: String?

    var mode: Mode {
        self.urlString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .canvas : .web
    }

    /// Callback invoked when a clawdis:// deep link is tapped in the canvas
    var onDeepLink: ((URL) -> Void)?

    /// Callback invoked when the user clicks an A2UI action (e.g. button) inside the canvas web UI.
    var onA2UIAction: (([String: Any]) -> Void)?

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let a2uiActionHandler = CanvasA2UIActionMessageHandler()
        let userContentController = WKUserContentController()
        userContentController.add(a2uiActionHandler, name: CanvasA2UIActionMessageHandler.messageName)
        config.userContentController = userContentController
        self.navigationDelegate = ScreenNavigationDelegate()
        self.a2uiActionHandler = a2uiActionHandler
        self.webView = WKWebView(frame: .zero, configuration: config)
        // Canvas scaffold is a fully self-contained HTML page; avoid relying on transparency underlays.
        self.webView.isOpaque = true
        self.webView.backgroundColor = .black
        self.webView.scrollView.backgroundColor = .black
        self.webView.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView.scrollView.contentInset = .zero
        self.webView.scrollView.scrollIndicatorInsets = .zero
        self.webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        // Disable scroll to allow touch events to pass through to canvas
        self.webView.scrollView.isScrollEnabled = false
        self.webView.scrollView.bounces = false
        self.webView.navigationDelegate = self.navigationDelegate
        self.navigationDelegate.controller = self
        a2uiActionHandler.controller = self
        self.reload()
    }

    func navigate(to urlString: String) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        self.urlString = (trimmed == "/" ? "" : trimmed)
        self.reload()
    }

    func reload() {
        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard let url = Self.canvasScaffoldURL else { return }
            self.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        } else {
            guard let url = URL(string: trimmed) else { return }
            if url.isFileURL {
                self.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            } else {
                self.webView.load(URLRequest(url: url))
            }
        }
    }

    func showDefaultCanvas() {
        self.urlString = ""
        self.reload()
    }

    func waitForA2UIReady(timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await self.eval(javaScript: """
                (() => {
                  try {
                    return !!globalThis.clawdisA2UI && typeof globalThis.clawdisA2UI.applyMessages === 'function';
                  } catch (_) { return false; }
                })()
                """)
                if res == "true" { return true }
            } catch {
                // ignore; page likely still loading
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return false
    }

    func eval(javaScript: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            self.webView.evaluateJavaScript(javaScript) { result, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if let result {
                    cont.resume(returning: String(describing: result))
                } else {
                    cont.resume(returning: "")
                }
            }
        }
    }

    func snapshotPNGBase64(maxWidth: CGFloat? = nil) async throws -> String {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }
        guard let data = image.pngData() else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    // SwiftPM flattens resource directories; ensure resource filenames are unique.
    private static let canvasScaffoldURL: URL? = ClawdisKitResources.bundle.url(
        forResource: "scaffold",
        withExtension: "html")
    private static let a2uiIndexURL: URL? = ClawdisKitResources.bundle.url(forResource: "index", withExtension: "html")

    fileprivate func isTrustedCanvasUIURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        let std = url.standardizedFileURL
        if let expected = Self.canvasScaffoldURL,
           std == expected.standardizedFileURL
        {
            return true
        }
        if let expected = Self.a2uiIndexURL,
           std == expected.standardizedFileURL
        {
            return true
        }
        return false
    }
}

// MARK: - Navigation Delegate

/// Handles navigation policy to intercept clawdis:// deep links from canvas
private final class ScreenNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var controller: ScreenController?

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        // Intercept clawdis:// deep links
        if url.scheme == "clawdis" {
            decisionHandler(.cancel)
            Task { @MainActor in
                self.controller?.onDeepLink?(url)
            }
            return
        }

        decisionHandler(.allow)
    }
}

private final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "clawdisCanvasA2UIAction"

    weak var controller: ScreenController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }
        guard let controller else { return }

        // Only accept actions from local bundled canvas/A2UI content (not arbitrary web pages).
        guard let url = message.webView?.url, controller.isTrustedCanvasUIURL(url) else { return }

        let body: [String: Any] = {
            if let dict = message.body as? [String: Any] { return dict }
            if let dict = message.body as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !body.isEmpty else { return }

        controller.onA2UIAction?(body)
    }
}
