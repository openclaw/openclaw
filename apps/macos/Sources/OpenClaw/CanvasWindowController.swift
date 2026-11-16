import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import WebKit

@MainActor
final class CanvasWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let sessionKey: String
    private let sessionDir: URL
    private let schemeHandler: CanvasSchemeHandler
    let webView: WKWebView
    let watcher: CanvasFileWatcher
    private let container: HoverChromeContainerView
    private let anchorProvider: () -> NSRect?
    var preferredPlacement: CanvasPlacement?
    private var debugStatusEnabled = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?
    private var canvasVisible = false
    private var watchesLocalCanvasFiles = false

    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, root: URL, anchorProvider: @escaping () -> NSRect?) throws {
        self.sessionKey = sessionKey
        self.anchorProvider = anchorProvider

        let safeSessionKey = CanvasWindowController.sanitizeSessionKey(sessionKey)
        self.sessionDir = root.appendingPathComponent(safeSessionKey, isDirectory: true)
        try FileManager().createDirectory(at: self.sessionDir, withIntermediateDirectories: true)

        self.schemeHandler = CanvasSchemeHandler(root: root)

        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.tabFocusesLinks = true
        config.setURLSchemeHandler(self.schemeHandler, forURLScheme: CanvasScheme.scheme)

        self.webView = WKWebView(frame: .zero, configuration: config)
        // Presented documents render against an opaque surface.
        self.webView.setValue(true, forKey: "drawsBackground")

        let sessionDir = self.sessionDir
        let webView = self.webView
        self.watcher = CanvasFileWatcher(url: sessionDir) { [weak webView] in
            Task { @MainActor in
                guard let webView else { return }

                // Only auto-reload when we are showing local canvas content.
                guard webView.url?.scheme == CanvasScheme.scheme else { return }

                let path = webView.url?.path ?? ""
                if path == "/" || path.isEmpty {
                    let indexA = sessionDir.appendingPathComponent("index.html", isDirectory: false)
                    let indexB = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
                    if !FileManager().fileExists(atPath: indexA.path),
                       !FileManager().fileExists(atPath: indexB.path)
                    {
                        return
                    }
                }

                webView.reload()
            }
        }

        self.container = HoverChromeContainerView(containing: self.webView)
        let window = Self.makePanel(contentView: self.container)
        super.init(window: window)

        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.window?.delegate = self
        self.container.onClose = { [weak self] in
            self?.hideCanvas()
        }

        // Keep event delivery active while hidden so file changes are not lost.
        // The recursive polling fallback is enabled only for visible local Canvas content.
        self.watcher.startEventStream()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @MainActor deinit {
        self.watcher.stop()
    }

    func showCanvas(path: String? = nil) {
        self.presentAnchoredPanel(anchorProvider: self.anchorProvider)
        if let path {
            self.load(target: path)
        }
    }

    func hideCanvas() {
        self.persistFrame()
        window?.orderOut(nil)
        self.setCanvasVisible(false)
    }

    func load(target: String) {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == CanvasScheme.scheme {
                self.webView.load(URLRequest(url: url))
                return
            }
            if scheme == "https" || scheme == "http" {
                self.webView.load(URLRequest(url: url))
                return
            }
        }

        guard let url = CanvasScheme.makeURL(
            session: CanvasWindowController.sanitizeSessionKey(sessionKey),
            path: trimmed)
        else {
            canvasWindowLogger
                .error(
                    "invalid canvas url session=\(self.sessionKey, privacy: .public)")
            return
        }
        self.webView.load(URLRequest(url: url))
    }

    func setCanvasVisible(_ visible: Bool) {
        self.canvasVisible = visible
        self.updateFilePolling()
        self.onVisibilityChanged?(visible)
    }

    func updateFilePollingForCommittedNavigation(to url: URL) {
        // Requested navigations can fail or redirect, so polling follows the
        // committed main-frame document rather than the requested target.
        self.watchesLocalCanvasFiles = url.scheme?.lowercased() == CanvasScheme.scheme
        self.updateFilePolling()
    }

    private func updateFilePolling() {
        self.watcher.setPollingEnabled(self.canvasVisible && self.watchesLocalCanvasFiles)
    }

    func updateDebugStatus(enabled: Bool, title: String?, subtitle: String?) {
        self.webView.configuration.preferences.setValue(enabled, forKey: "developerExtrasEnabled")
        self.debugStatusEnabled = enabled
        self.debugStatusTitle = title
        self.debugStatusSubtitle = subtitle
        self.applyDebugStatusIfNeeded()
    }

    func applyDebugStatusIfNeeded() {
        WebViewJavaScriptSupport.applyDebugStatus(
            webView: self.webView,
            enabled: self.debugStatusEnabled,
            title: self.debugStatusTitle,
            subtitle: self.debugStatusSubtitle)
    }

    var directoryPath: String {
        self.sessionDir.path
    }
}
