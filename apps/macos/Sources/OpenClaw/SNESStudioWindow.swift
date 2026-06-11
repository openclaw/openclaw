import AppKit
import Foundation
import WebKit

private enum SNESStudioWindowLayout {
    static let defaultSize = NSSize(width: 1280, height: 900)
    static let minimumSize = NSSize(width: 960, height: 680)
}

@MainActor
final class SNESStudioWindowController: NSWindowController, WKNavigationDelegate {
    private let webView: WKWebView

    init(url: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView = webView

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: SNESStudioWindowLayout.defaultSize),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false)
        window.title = "SNES Studio"
        window.minSize = SNESStudioWindowLayout.minimumSize
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.center()
        WindowPlacement.ensureOnScreen(window: window, defaultSize: SNESStudioWindowLayout.defaultSize)

        super.init(window: window)
        self.webView.navigationDelegate = self
        self.load(url: url)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(url: URL) {
        self.load(url: url)
        self.showWindow(nil)
        self.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func load(url: URL) {
        if self.webView.url == url { return }
        self.webView.load(URLRequest(url: url))
    }
}

@MainActor
final class SNESStudioWindowManager {
    static let shared = SNESStudioWindowManager()

    private var controller: SNESStudioWindowController?

    func show(url: URL) {
        if let controller {
            controller.show(url: url)
            return
        }
        let controller = SNESStudioWindowController(url: url)
        self.controller = controller
        controller.show(url: url)
    }

    func close() {
        self.controller?.close()
        self.controller = nil
    }
}
