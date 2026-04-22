import AppKit
import Foundation
import OSLog
import WebKit

private let wallboardLogger = Logger(subsystem: "ai.openclaw", category: "Wallboard")

@MainActor
final class WallboardWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate {
    let webView: WKWebView
    private var targetScreen: NSScreen?

    init(targetScreen: NSScreen?) {
        self.targetScreen = targetScreen

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        self.webView = WKWebView(frame: .zero, configuration: config)
        self.webView.setValue(false, forKey: "drawsBackground") // black window fills gaps during load

        let screen = targetScreen ?? NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
            screen: screen)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        window.level = .normal
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.ignoresMouseEvents = false
        window.contentView = self.webView

        super.init(window: window)
        window.delegate = self
        self.webView.navigationDelegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func present() {
        guard let window else { return }
        if let screen = self.targetScreen ?? NSScreen.main ?? NSScreen.screens.first {
            window.setFrame(screen.frame, display: false)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        wallboardLogger.info("wallboard window presented")
    }

    func loadBundledPlaceholder() {
        guard let url = Bundle.module.url(
            forResource: "placeholder",
            withExtension: "html",
            subdirectory: "Wallboard")
        else {
            wallboardLogger.error("wallboard placeholder not found in bundle")
            return
        }
        self.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func dismiss() {
        self.window?.orderOut(nil)
        wallboardLogger.info("wallboard window dismissed")
    }

    // MARK: - NSWindowDelegate
    func windowWillClose(_: Notification) {
        wallboardLogger.info("wallboard window will close")
    }

    // MARK: - WKNavigationDelegate
    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        wallboardLogger.error("wallboard load failed: \(error.localizedDescription, privacy: .public)")
    }
}
