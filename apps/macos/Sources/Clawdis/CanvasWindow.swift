import AppKit
import ClawdisIPC
import Foundation
import OSLog
import QuartzCore
import WebKit

private let canvasWindowLogger = Logger(subsystem: "com.steipete.clawdis", category: "Canvas")

private enum CanvasLayout {
    static let panelSize = NSSize(width: 520, height: 680)
    static let windowSize = NSSize(width: 1120, height: 840)
    static let anchorPadding: CGFloat = 8
    static let defaultPadding: CGFloat = 10
    static let minPanelSize = NSSize(width: 360, height: 360)
}

final class CanvasPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

enum CanvasPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)

    var isPanel: Bool {
        if case .panel = self { return true }
        return false
    }
}

@MainActor
final class CanvasWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate {
    private let sessionKey: String
    private let root: URL
    private let sessionDir: URL
    private let schemeHandler: CanvasSchemeHandler
    private let webView: WKWebView
    private var a2uiActionMessageHandler: CanvasA2UIActionMessageHandler?
    private let watcher: CanvasFileWatcher
    private let container: HoverChromeContainerView
    let presentation: CanvasPresentation
    private var preferredPlacement: CanvasPlacement?

    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, root: URL, presentation: CanvasPresentation) throws {
        self.sessionKey = sessionKey
        self.root = root
        self.presentation = presentation

        let safeSessionKey = CanvasWindowController.sanitizeSessionKey(sessionKey)
        self.sessionDir = root.appendingPathComponent(safeSessionKey, isDirectory: true)
        try FileManager.default.createDirectory(at: self.sessionDir, withIntermediateDirectories: true)

        self.schemeHandler = CanvasSchemeHandler(root: root)

        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.setURLSchemeHandler(self.schemeHandler, forURLScheme: CanvasScheme.scheme)

        self.webView = WKWebView(frame: .zero, configuration: config)
        self.webView.setValue(false, forKey: "drawsBackground")

        let sessionDir = self.sessionDir
        let webView = self.webView
        self.watcher = CanvasFileWatcher(url: sessionDir) { [weak webView] in
            Task { @MainActor in
                guard let webView else { return }

                // Only auto-reload when we are showing local canvas content.
                guard webView.url?.scheme == CanvasScheme.scheme else { return }

                // Avoid reloading the built-in A2UI shell due to filesystem noise (it does not depend on session files).
                let path = webView.url?.path ?? ""
                if path.hasPrefix("/__clawdis__/a2ui") { return }
                if path == "/" || path.isEmpty {
                    let indexA = sessionDir.appendingPathComponent("index.html", isDirectory: false)
                    let indexB = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
                    if !FileManager.default.fileExists(atPath: indexA.path),
                       !FileManager.default.fileExists(atPath: indexB.path)
                    {
                        return
                    }
                }

                webView.reload()
            }
        }

        self.container = HoverChromeContainerView(containing: self.webView)
        let window = Self.makeWindow(for: presentation, contentView: self.container)
        super.init(window: window)

        let handler = CanvasA2UIActionMessageHandler(sessionKey: sessionKey)
        self.a2uiActionMessageHandler = handler
        self.webView.configuration.userContentController.add(handler, name: CanvasA2UIActionMessageHandler.messageName)

        self.webView.navigationDelegate = self
        self.window?.delegate = self
        self.container.onClose = { [weak self] in
            self?.hideCanvas()
        }

        self.watcher.start()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @MainActor deinit {
        self.webView.configuration.userContentController.removeScriptMessageHandler(forName: CanvasA2UIActionMessageHandler.messageName)
        self.watcher.stop()
    }

    func applyPreferredPlacement(_ placement: CanvasPlacement?) {
        self.preferredPlacement = placement
    }

    func showCanvas(path: String? = nil) {
        if case let .panel(anchorProvider) = self.presentation {
            self.presentAnchoredPanel(anchorProvider: anchorProvider)
            if let path {
                self.load(target: path)
            }
            return
        }

        self.showWindow(nil)
        self.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let path {
            self.load(target: path)
        }
        self.onVisibilityChanged?(true)
    }

    func hideCanvas() {
        if case .panel = self.presentation {
            self.persistFrameIfPanel()
            self.window?.orderOut(nil)
        } else {
            self.close()
        }
        self.onVisibilityChanged?(false)
    }

    func load(target: String) {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == "https" || scheme == "http" {
                canvasWindowLogger.debug("canvas load url \(url.absoluteString, privacy: .public)")
                self.webView.load(URLRequest(url: url))
                return
            }
            if scheme == "file" {
                canvasWindowLogger.debug("canvas load file \(url.absoluteString, privacy: .public)")
                self.loadFile(url)
                return
            }
        }

        // Convenience: absolute file paths resolve as local files when they exist.
        // (Avoid treating Canvas routes like "/" as filesystem paths.)
        if trimmed.hasPrefix("/") {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: trimmed, isDirectory: &isDir), !isDir.boolValue {
            let url = URL(fileURLWithPath: trimmed)
            canvasWindowLogger.debug("canvas load file \(url.absoluteString, privacy: .public)")
            self.loadFile(url)
            return
            }
        }

        guard let url = CanvasScheme.makeURL(
            session: CanvasWindowController.sanitizeSessionKey(self.sessionKey),
            path: trimmed)
        else {
            canvasWindowLogger
                .error(
                    "invalid canvas url session=\(self.sessionKey, privacy: .public) path=\(trimmed, privacy: .public)")
            return
        }
        canvasWindowLogger.debug("canvas load canvas \(url.absoluteString, privacy: .public)")
        self.webView.load(URLRequest(url: url))
    }

    private func loadFile(_ url: URL) {
        let fileURL = url.isFileURL ? url : URL(fileURLWithPath: url.path)
        let accessDir = fileURL.deletingLastPathComponent()
        self.webView.loadFileURL(fileURL, allowingReadAccessTo: accessDir)
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

    func snapshot(to outPath: String?) async throws -> String {
        let image: NSImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: nil) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Canvas", code: 11, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot returned nil image",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }

        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else {
            throw NSError(domain: "Canvas", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "failed to encode png",
            ])
        }

        let path: String
        if let outPath, !outPath.isEmpty {
            path = outPath
        } else {
            let ts = Int(Date().timeIntervalSince1970)
            path = "/tmp/clawdis-canvas-\(CanvasWindowController.sanitizeSessionKey(self.sessionKey))-\(ts).png"
        }

        try png.write(to: URL(fileURLWithPath: path), options: [.atomic])
        return path
    }

    var directoryPath: String {
        self.sessionDir.path
    }

    // MARK: - Window

    private static func makeWindow(for presentation: CanvasPresentation, contentView: NSView) -> NSWindow {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: CanvasLayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "Clawdis Canvas"
            window.contentView = contentView
            window.center()
            window.minSize = NSSize(width: 880, height: 680)
            return window

        case .panel:
            let panel = CanvasPanel(
                contentRect: NSRect(origin: .zero, size: CanvasLayout.panelSize),
                styleMask: [.borderless, .resizable],
                backing: .buffered,
                defer: false)
            // Keep Canvas below the Voice Wake overlay panel.
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue - 1)
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentView = contentView
            panel.becomesKeyOnlyIfNeeded = true
            panel.hidesOnDeactivate = false
            panel.minSize = CanvasLayout.minPanelSize
            return panel
        }
    }

    func presentAnchoredPanel(anchorProvider: @escaping () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.repositionPanel(using: anchorProvider)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(self.webView)
        VoiceWakeOverlayController.shared.bringToFrontIfVisible()
        self.onVisibilityChanged?(true)
    }

    private func repositionPanel(using anchorProvider: () -> NSRect?) {
        guard let panel = self.window else { return }
        let anchor = anchorProvider()
        let targetScreen = Self.screen(forAnchor: anchor)
            ?? Self.screenContainingMouseCursor()
            ?? panel.screen
            ?? NSScreen.main
            ?? NSScreen.screens.first

        let restored = Self.loadRestoredFrame(sessionKey: self.sessionKey)
        let restoredIsValid = if let restored, let targetScreen {
            Self.isFrameMeaningfullyVisible(restored, on: targetScreen)
        } else {
            restored != nil
        }

        var frame = if let restored, restoredIsValid {
            restored
        } else {
            Self.defaultTopRightFrame(panel: panel, screen: targetScreen)
        }

        // Apply agent placement as partial overrides:
        // - If agent provides x/y, override origin.
        // - If agent provides width/height, override size.
        // - If agent provides only size, keep the remembered origin.
        if let placement = self.preferredPlacement {
            if let x = placement.x { frame.origin.x = x }
            if let y = placement.y { frame.origin.y = y }
            if let w = placement.width { frame.size.width = max(CanvasLayout.minPanelSize.width, CGFloat(w)) }
            if let h = placement.height { frame.size.height = max(CanvasLayout.minPanelSize.height, CGFloat(h)) }
        }

        self.setPanelFrame(frame, on: targetScreen)
    }

    private static func defaultTopRightFrame(panel: NSWindow, screen: NSScreen?) -> NSRect {
        let w = max(CanvasLayout.minPanelSize.width, panel.frame.width)
        let h = max(CanvasLayout.minPanelSize.height, panel.frame.height)
        return WindowPlacement.topRightFrame(
            size: NSSize(width: w, height: h),
            padding: CanvasLayout.defaultPadding,
            on: screen)
    }

    private func setPanelFrame(_ frame: NSRect, on screen: NSScreen?) {
        guard let panel = self.window else { return }
        guard let s = screen ?? panel.screen ?? NSScreen.main ?? NSScreen.screens.first else {
            panel.setFrame(frame, display: false)
            self.persistFrameIfPanel()
            return
        }

        let constrained = Self.constrainFrame(frame, toVisibleFrame: s.visibleFrame)
        panel.setFrame(constrained, display: false)
        self.persistFrameIfPanel()
    }

    private static func screen(forAnchor anchor: NSRect?) -> NSScreen? {
        guard let anchor else { return nil }
        let center = NSPoint(x: anchor.midX, y: anchor.midY)
        return NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(center)
        }
    }

    private static func screenContainingMouseCursor() -> NSScreen? {
        let point = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(point) }
    }

    private static func isFrameMeaningfullyVisible(_ frame: NSRect, on screen: NSScreen) -> Bool {
        frame.intersects(screen.visibleFrame.insetBy(dx: 12, dy: 12))
    }

    fileprivate static func constrainFrame(_ frame: NSRect, toVisibleFrame bounds: NSRect) -> NSRect {
        if bounds == .zero { return frame }

        var next = frame
        next.size.width = min(max(CanvasLayout.minPanelSize.width, next.size.width), bounds.width)
        next.size.height = min(max(CanvasLayout.minPanelSize.height, next.size.height), bounds.height)

        let maxX = bounds.maxX - next.size.width
        let maxY = bounds.maxY - next.size.height

        next.origin.x = maxX >= bounds.minX ? min(max(next.origin.x, bounds.minX), maxX) : bounds.minX
        next.origin.y = maxY >= bounds.minY ? min(max(next.origin.y, bounds.minY), maxY) : bounds.minY

        next.origin.x = round(next.origin.x)
        next.origin.y = round(next.origin.y)
        return next
    }

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
            NSWorkspace.shared.open(
                [url],
                withApplicationAt: appURL,
                configuration: NSWorkspace.OpenConfiguration(),
                completionHandler: nil)
        } else {
            canvasWindowLogger.debug("no application to open url \(url.absoluteString, privacy: .public)")
        }
        decisionHandler(.cancel)
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_: Notification) {
        self.onVisibilityChanged?(false)
    }

    func windowDidMove(_: Notification) {
        self.persistFrameIfPanel()
    }

    func windowDidEndLiveResize(_: Notification) {
        self.persistFrameIfPanel()
    }

    private func persistFrameIfPanel() {
        guard case .panel = self.presentation, let window else { return }
        Self.storeRestoredFrame(window.frame, sessionKey: self.sessionKey)
    }

    // MARK: - Helpers

    private static func sanitizeSessionKey(_ key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "main" }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-+")
        let scalars = trimmed.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        return String(scalars)
    }

    private static func storedFrameDefaultsKey(sessionKey: String) -> String {
        "clawdis.canvas.frame.\(self.sanitizeSessionKey(sessionKey))"
    }

    private static func loadRestoredFrame(sessionKey: String) -> NSRect? {
        let key = self.storedFrameDefaultsKey(sessionKey: sessionKey)
        guard let arr = UserDefaults.standard.array(forKey: key) as? [Double], arr.count == 4 else { return nil }
        let rect = NSRect(x: arr[0], y: arr[1], width: arr[2], height: arr[3])
        if rect.width < CanvasLayout.minPanelSize.width || rect.height < CanvasLayout.minPanelSize.height { return nil }
        return rect
    }

    private static func storeRestoredFrame(_ frame: NSRect, sessionKey: String) {
        let key = self.storedFrameDefaultsKey(sessionKey: sessionKey)
        UserDefaults.standard.set(
            [Double(frame.origin.x), Double(frame.origin.y), Double(frame.size.width), Double(frame.size.height)],
            forKey: key)
    }
}

private final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "clawdisCanvasA2UIAction"

    private let sessionKey: String

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        super.init()
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }

        // Only accept actions from local Canvas content (not arbitrary web pages).
        guard let webView = message.webView,
              webView.url?.scheme == CanvasScheme.scheme
        else { return }

        let path = webView.url?.path ?? ""
        guard path == "/" || path.isEmpty || path.hasPrefix("/__clawdis__/a2ui") else { return }

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

        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = userAction["name"] as? String, !name.isEmpty else { return }

        let json: String = {
            if let data = try? JSONSerialization.data(withJSONObject: userAction, options: [.prettyPrinted, .sortedKeys]),
               let str = String(data: data, encoding: .utf8)
            {
                return str
            }
            return ""
        }()

        canvasWindowLogger.info("A2UI action \(name, privacy: .public) session=\(self.sessionKey, privacy: .public)")

        let text = json.isEmpty
            ? "A2UI action: \(name)"
            : "A2UI action: \(name)\n\n```json\n\(json)\n```"

        Task {
            let result = await GatewayConnection.shared.sendAgent(
                message: text,
                thinking: nil,
                sessionKey: self.sessionKey,
                deliver: false,
                to: nil,
                channel: "webchat")
            if !result.ok {
                canvasWindowLogger.error(
                    "A2UI action send failed name=\(name, privacy: .public) error=\(result.error ?? "unknown", privacy: .public)")
            }
        }
    }
}

// MARK: - Hover chrome container

private final class HoverChromeContainerView: NSView {
    private let content: NSView
    private let chrome: CanvasChromeOverlayView
    private var tracking: NSTrackingArea?
    var onClose: (() -> Void)?

    init(containing content: NSView) {
        self.content = content
        self.chrome = CanvasChromeOverlayView(frame: .zero)
        super.init(frame: .zero)

        self.wantsLayer = true
        self.layer?.cornerRadius = 12
        self.layer?.masksToBounds = true
        self.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        self.content.translatesAutoresizingMaskIntoConstraints = false
        self.addSubview(self.content)

        self.chrome.translatesAutoresizingMaskIntoConstraints = false
        self.chrome.alphaValue = 0
        self.chrome.onClose = { [weak self] in self?.onClose?() }
        self.addSubview(self.chrome)

        NSLayoutConstraint.activate([
            self.content.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            self.content.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            self.content.topAnchor.constraint(equalTo: self.topAnchor),
            self.content.bottomAnchor.constraint(equalTo: self.bottomAnchor),

            self.chrome.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            self.chrome.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            self.chrome.topAnchor.constraint(equalTo: self.topAnchor),
            self.chrome.bottomAnchor.constraint(equalTo: self.bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking {
            self.removeTrackingArea(tracking)
        }
        let area = NSTrackingArea(
            rect: self.bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil)
        self.addTrackingArea(area)
        self.tracking = area
    }

    private final class CanvasDragHandleView: NSView {
        override func mouseDown(with event: NSEvent) {
            self.window?.performDrag(with: event)
        }

        override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }
    }

    private final class CanvasResizeHandleView: NSView {
        private var startPoint: NSPoint = .zero
        private var startFrame: NSRect = .zero

        override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            _ = window.makeFirstResponder(self)
            self.startPoint = NSEvent.mouseLocation
            self.startFrame = window.frame
            super.mouseDown(with: event)
        }

        override func mouseDragged(with _: NSEvent) {
            guard let window else { return }
            let current = NSEvent.mouseLocation
            let dx = current.x - self.startPoint.x
            let dy = current.y - self.startPoint.y

            var frame = self.startFrame
            frame.size.width = max(CanvasLayout.minPanelSize.width, frame.size.width + dx)
            frame.origin.y += dy
            frame.size.height = max(CanvasLayout.minPanelSize.height, frame.size.height - dy)

            if let screen = window.screen {
                frame = CanvasWindowController.constrainFrame(frame, toVisibleFrame: screen.visibleFrame)
            }
            window.setFrame(frame, display: true)
        }
    }

    private final class CanvasChromeOverlayView: NSView {
        var onClose: (() -> Void)?

        private let dragHandle = CanvasDragHandleView(frame: .zero)
        private let resizeHandle = CanvasResizeHandleView(frame: .zero)

        private final class PassthroughVisualEffectView: NSVisualEffectView {
            override func hitTest(_: NSPoint) -> NSView? { nil }
        }

        private let closeBackground: NSVisualEffectView = {
            let v = PassthroughVisualEffectView(frame: .zero)
            v.material = .hudWindow
            v.blendingMode = .withinWindow
            v.state = .active
            v.appearance = NSAppearance(named: .vibrantDark)
            v.wantsLayer = true
            v.layer?.cornerRadius = 10
            v.layer?.masksToBounds = true
            v.layer?.borderWidth = 1
            v.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
            v.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.22).cgColor
            v.layer?.shadowColor = NSColor.black.withAlphaComponent(0.35).cgColor
            v.layer?.shadowOpacity = 0.35
            v.layer?.shadowRadius = 8
            v.layer?.shadowOffset = .zero
            return v
        }()

        private let closeButton: NSButton = {
            let cfg = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
            let img = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
                .withSymbolConfiguration(cfg)
                ?? NSImage(size: NSSize(width: 18, height: 18))
            let btn = NSButton(image: img, target: nil, action: nil)
            btn.isBordered = false
            btn.bezelStyle = .regularSquare
            btn.imageScaling = .scaleProportionallyDown
            btn.contentTintColor = NSColor.labelColor
            btn.toolTip = "Close"
            return btn
        }()

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)

            self.wantsLayer = true
            self.layer?.cornerRadius = 12
            self.layer?.masksToBounds = true
            self.layer?.borderWidth = 1
            self.layer?.borderColor = NSColor.black.withAlphaComponent(0.18).cgColor
            self.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.02).cgColor

            self.dragHandle.translatesAutoresizingMaskIntoConstraints = false
            self.dragHandle.wantsLayer = true
            self.dragHandle.layer?.backgroundColor = NSColor.clear.cgColor
            self.addSubview(self.dragHandle)

            self.resizeHandle.translatesAutoresizingMaskIntoConstraints = false
            self.resizeHandle.wantsLayer = true
            self.resizeHandle.layer?.backgroundColor = NSColor.clear.cgColor
            self.addSubview(self.resizeHandle)

            self.closeBackground.translatesAutoresizingMaskIntoConstraints = false
            self.addSubview(self.closeBackground)

            self.closeButton.translatesAutoresizingMaskIntoConstraints = false
            self.closeButton.target = self
            self.closeButton.action = #selector(self.handleClose)
            self.addSubview(self.closeButton)

            NSLayoutConstraint.activate([
                self.dragHandle.leadingAnchor.constraint(equalTo: self.leadingAnchor),
                self.dragHandle.trailingAnchor.constraint(equalTo: self.trailingAnchor),
                self.dragHandle.topAnchor.constraint(equalTo: self.topAnchor),
                self.dragHandle.heightAnchor.constraint(equalToConstant: 30),

                self.closeBackground.centerXAnchor.constraint(equalTo: self.closeButton.centerXAnchor),
                self.closeBackground.centerYAnchor.constraint(equalTo: self.closeButton.centerYAnchor),
                self.closeBackground.widthAnchor.constraint(equalToConstant: 20),
                self.closeBackground.heightAnchor.constraint(equalToConstant: 20),

                self.closeButton.trailingAnchor.constraint(equalTo: self.trailingAnchor, constant: -8),
                self.closeButton.topAnchor.constraint(equalTo: self.topAnchor, constant: 8),
                self.closeButton.widthAnchor.constraint(equalToConstant: 20),
                self.closeButton.heightAnchor.constraint(equalToConstant: 20),

                self.resizeHandle.trailingAnchor.constraint(equalTo: self.trailingAnchor),
                self.resizeHandle.bottomAnchor.constraint(equalTo: self.bottomAnchor),
                self.resizeHandle.widthAnchor.constraint(equalToConstant: 18),
                self.resizeHandle.heightAnchor.constraint(equalToConstant: 18),
            ])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func hitTest(_ point: NSPoint) -> NSView? {
            // When the chrome is hidden, do not intercept any mouse events (let the WKWebView receive them).
            guard self.alphaValue > 0.02 else { return nil }

            if self.closeButton.frame.contains(point) { return self.closeButton }
            if self.dragHandle.frame.contains(point) { return self.dragHandle }
            if self.resizeHandle.frame.contains(point) { return self.resizeHandle }
            return nil
        }

        @objc private func handleClose() {
            self.onClose?()
        }
    }

    override func mouseEntered(with _: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.chrome.animator().alphaValue = 1
        }
    }

    override func mouseExited(with _: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.chrome.animator().alphaValue = 0
        }
    }
}
