import AppKit
import Foundation
import Network
import OSLog
import WebKit

private let webChatLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

enum WebChatPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)

    var isPanel: Bool {
        if case .panel = self { return true }
        return false
    }
}

@MainActor
final class WebChatWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate {
    private let webView: WKWebView
    private let sessionKey: String
    private var tunnel: WebChatTunnel?
    private var baseEndpoint: URL?
    private let remotePort: Int
    private var reachabilityTask: Task<Void, Never>?
    private var tunnelRestartEnabled = false
    private var bootWatchTask: Task<Void, Never>?
    let presentation: WebChatPresentation
    var onPanelClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?
    private var panelCloseNotified = false
    private var localDismissMonitor: Any?
    private var observers: [NSObjectProtocol] = []

    init(sessionKey: String, presentation: WebChatPresentation = .window) {
        webChatLogger.debug("init WebChatWindowController sessionKey=\(sessionKey, privacy: .public)")
        self.sessionKey = sessionKey
        self.remotePort = AppStateStore.webChatPort
        self.presentation = presentation

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        self.webView = WKWebView(frame: .zero, configuration: config)
        let window = Self.makeWindow(for: presentation, contentView: self.webView)
        super.init(window: window)
        self.webView.navigationDelegate = self
        self.window?.delegate = self

        self.loadPlaceholder()
        Task { await self.bootstrap() }

        if case .panel = presentation {
            self.installPanelObservers()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @MainActor deinit {
        self.reachabilityTask?.cancel()
        self.bootWatchTask?.cancel()
        self.stopTunnel(allowRestart: false)
        self.removeDismissMonitor()
        self.removePanelObservers()
    }

    private static func makeWindow(for presentation: WebChatPresentation, contentView: NSView) -> NSWindow {
        let wrappedContent = Self.makeRoundedContainer(containing: contentView)
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "Clawd Web Chat"
            window.contentView = wrappedContent
            return window
        case .panel:
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
                styleMask: [.nonactivatingPanel, .borderless],
                backing: .buffered,
                defer: false)
            panel.level = .statusBar
            panel.hidesOnDeactivate = true
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentView = wrappedContent
            panel.becomesKeyOnlyIfNeeded = true
            return panel
        }
    }

    private static func makeRoundedContainer(containing contentView: NSView) -> NSView {
        let container = NSView(frame: .zero)
        container.wantsLayer = true
        container.layer?.cornerRadius = 12
        container.layer?.masksToBounds = true
        container.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        contentView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentView)
        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: container.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    private func loadPlaceholder() {
        let html = """
        <html><body style='font-family:-apple-system;margin:0;padding:0;display:flex;align-items:center;justify-content:center;height:100vh;color:#888'>Connecting to web chat…</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    private func loadPage(baseURL: URL) {
        self.webView.load(URLRequest(url: baseURL))
        self.startBootWatch()
        webChatLogger.debug("loadPage url=\(baseURL.absoluteString, privacy: .public)")
    }

    // MARK: - Bootstrap

    private func bootstrap() async {
        do {
            guard AppStateStore.webChatEnabled else {
                throw NSError(
                    domain: "WebChat",
                    code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "Web chat disabled in settings"])
            }
            let endpoint = try await self.prepareEndpoint(remotePort: self.remotePort)
            self.baseEndpoint = endpoint
            self.reachabilityTask?.cancel()
            self.reachabilityTask = Task { [endpoint, weak self] in
                guard let self else { return }
                do {
                    try await self.verifyReachable(endpoint: endpoint)
                    await MainActor.run { self.loadWebChat(baseEndpoint: endpoint) }
                } catch {
                    await MainActor.run { self.showError(error.localizedDescription) }
                }
            }
        } catch {
            let message = error.localizedDescription
            webChatLogger.error("webchat bootstrap failed: \(message, privacy: .public)")
            await MainActor.run { self.showError(message) }
        }
    }

    private func prepareEndpoint(remotePort: Int) async throws -> URL {
        if CommandResolver.connectionModeIsRemote() {
            return try await self.startOrRestartTunnel()
        } else {
            return URL(string: "http://127.0.0.1:\(remotePort)/")!
        }
    }

    private func loadWebChat(baseEndpoint: URL) {
        var comps = URLComponents(url: baseEndpoint.appendingPathComponent("webchat/"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "session", value: self.sessionKey)]
        if let hostName = Host.current().localizedName ?? Host.current().name {
            items.append(URLQueryItem(name: "host", value: hostName))
        }
        if let ip = Self.primaryIPv4Address() {
            items.append(URLQueryItem(name: "ip", value: ip))
        }
        comps?.queryItems = items
        guard let url = comps?.url else {
            self.showError("invalid webchat url")
            return
        }
        self.loadPage(baseURL: url)
    }

    private func startBootWatch() {
        self.bootWatchTask?.cancel()
        self.bootWatchTask = Task { [weak self] in
            guard let self else { return }
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                if await self.isWebChatBooted() { return }
            }
            await MainActor.run {
                self.showError("web chat did not finish booting. Check that the gateway is running and try reopening.")
            }
        }
    }

    private func isWebChatBooted() async -> Bool {
        await withCheckedContinuation { cont in
            self.webView.evaluateJavaScript("document.getElementById('app')?.dataset.booted === '1' || document.body.dataset.webchatError === '1'") { result, _ in
                cont.resume(returning: result as? Bool ?? false)
            }
        }
    }

    private func verifyReachable(endpoint: URL) async throws {
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 3)
        request.httpMethod = "HEAD"
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.waitsForConnectivity = false
        let session = URLSession(configuration: sessionConfig)
        do {
            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse {
                guard (200..<500).contains(http.statusCode) else {
                    throw NSError(
                        domain: "WebChat",
                        code: http.statusCode,
                        userInfo: [NSLocalizedDescriptionKey: "webchat returned HTTP \(http.statusCode)"])
                }
            }
        } catch {
            throw NSError(
                domain: "WebChat",
                code: 7,
                userInfo: [NSLocalizedDescriptionKey: "webchat unreachable: \(error.localizedDescription)"])
        }
    }

    private func startOrRestartTunnel() async throws -> URL {
        // Kill existing tunnel if any
        self.stopTunnel(allowRestart: false)

        let tunnel = try await WebChatTunnel.create(remotePort: self.remotePort, preferredLocalPort: 18788)
        self.tunnel = tunnel
        self.tunnelRestartEnabled = true

        // Auto-restart on unexpected termination while window lives
        tunnel.process.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.tunnelRestartEnabled else { return }
                webChatLogger.error("webchat tunnel terminated; restarting")
                do {
                    // Recreate the tunnel silently so the window keeps working without user intervention.
                    let base = try await self.startOrRestartTunnel()
                    self.loadPage(baseURL: base)
                } catch {
                    self.showError(error.localizedDescription)
                }
            }
        }

        guard let port = tunnel.localPort else {
            throw NSError(domain: "WebChat", code: 2, userInfo: [NSLocalizedDescriptionKey: "tunnel missing port"])
        }
        return URL(string: "http://127.0.0.1:\(port)/")!
    }

    private func stopTunnel(allowRestart: Bool) {
        self.tunnelRestartEnabled = allowRestart
        self.tunnel?.terminate()
        self.tunnel = nil
    }

    func presentAnchoredPanel(anchorProvider: @escaping () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.panelCloseNotified = false
        self.repositionPanel(using: anchorProvider)
        self.installDismissMonitor()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(self.webView)
        self.onVisibilityChanged?(true)
    }

    func closePanel() {
        guard case .panel = self.presentation else { return }
        self.removeDismissMonitor()
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.notifyPanelClosedOnce()
    }

    private func repositionPanel(using anchorProvider: () -> NSRect?) {
        guard let panel = self.window else { return }
        guard let anchor = anchorProvider() else { return }

        var frame = panel.frame
        frame.origin.x = round(anchor.midX - frame.width / 2)
        frame.origin.y = anchor.minY - frame.height
        panel.setFrame(frame, display: false)
    }

    private func showError(_ text: String) {
        self.bootWatchTask?.cancel()
        let html = """
        <html><body style='font-family:-apple-system;margin:0;padding:0;display:flex;align-items:center;justify-content:center;height:100vh;color:#c00'>Web chat failed to connect.<br><br>\(
            text)</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    func shutdown() {
        self.reachabilityTask?.cancel()
        self.bootWatchTask?.cancel()
        self.stopTunnel(allowRestart: false)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webChatLogger.debug("didFinish navigation url=\(webView.url?.absoluteString ?? "nil", privacy: .public)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webChatLogger.error("webchat navigation failed (provisional): \(error.localizedDescription, privacy: .public)")
        self.showError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webChatLogger.error("webchat navigation failed: \(error.localizedDescription, privacy: .public)")
        self.showError(error.localizedDescription)
    }

    func windowDidResignKey(_ notification: Notification) {
        guard case .panel = self.presentation else { return }
        self.closePanel()
        self.notifyPanelClosedOnce()
    }

    func windowWillClose(_ notification: Notification) {
        guard case .panel = self.presentation else { return }
        self.removeDismissMonitor()
        self.onVisibilityChanged?(false)
        self.notifyPanelClosedOnce()
    }

    private func notifyPanelClosedOnce() {
        guard !self.panelCloseNotified else { return }
        self.panelCloseNotified = true
        self.onPanelClosed?()
    }

    private func installDismissMonitor() {
        guard self.localDismissMonitor == nil, let panel = self.window else { return }
        self.localDismissMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            guard let self else { return event }
            if event.window !== panel {
                self.closePanel()
            }
            return event
        }
    }

    private func removeDismissMonitor() {
        if let monitor = self.localDismissMonitor {
            NSEvent.removeMonitor(monitor)
            self.localDismissMonitor = nil
        }
    }

    private func installPanelObservers() {
        guard let window = self.window else { return }
        let nc = NotificationCenter.default
        let o1 = nc.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.closePanel()
            }
        }
        let o2 = nc.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, case .panel = self.presentation else { return }
                if !(window.occlusionState.contains(.visible)) {
                    self.closePanel()
                }
            }
        }
        self.observers.append(contentsOf: [o1, o2])
    }

    private func removePanelObservers() {
        let nc = NotificationCenter.default
        for o in self.observers { nc.removeObserver(o) }
        self.observers.removeAll()
    }
}

extension WebChatWindowController {
    /// Returns the first non-loopback IPv4 address, skipping link-local (169.254.x.x).
    fileprivate static func primaryIPv4Address() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let addrFamily = ptr.pointee.ifa_addr.pointee.sa_family
            if (flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0 { continue }
            if addrFamily == UInt8(AF_INET) {
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(
                    ptr.pointee.ifa_addr,
                    socklen_t(ptr.pointee.ifa_addr.pointee.sa_len),
                    &hostname,
                    socklen_t(hostname.count),
                    nil,
                    0,
                    NI_NUMERICHOST) == 0
                {
                    let end = hostname.firstIndex(of: 0) ?? hostname.count
                    let bytes = hostname[..<end].map { UInt8(bitPattern: $0) }
                    let ip = String(decoding: bytes, as: UTF8.self)
                    if !ip.hasPrefix("169.254") { return ip }
                }
            }
        }
        return nil
    }
}

// MARK: - Manager

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()
    private var windowController: WebChatWindowController?
    private var panelController: WebChatWindowController?
    var onPanelVisibilityChanged: ((Bool) -> Void)?

    func show(sessionKey: String) {
        self.closePanel()
        if let controller = self.windowController {
            controller.showWindow(nil)
            controller.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let controller = WebChatWindowController(sessionKey: sessionKey)
        self.windowController = controller
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func togglePanel(sessionKey: String, anchorProvider: @escaping () -> NSRect?) {
        if let controller = self.panelController {
            if controller.window?.isVisible == true {
                controller.closePanel()
            } else {
                controller.presentAnchoredPanel(anchorProvider: anchorProvider)
            }
            return
        }

        let controller = WebChatWindowController(
            sessionKey: sessionKey,
            presentation: .panel(anchorProvider: anchorProvider))
        self.panelController = controller
        controller.onPanelClosed = { [weak self] in
            self?.panelHidden()
        }
        controller.onVisibilityChanged = { [weak self] visible in
            guard let self else { return }
            self.onPanelVisibilityChanged?(visible)
        }
        controller.presentAnchoredPanel(anchorProvider: anchorProvider)
        // visibility will be reported by the controller callback
    }

    func closePanel() {
        guard let controller = self.panelController else { return }
        controller.closePanel()
    }

    func preferredSessionKey() -> String {
        // Prefer canonical main session; fall back to most recent.
        let storePath = SessionLoader.defaultStorePath
        if let data = try? Data(contentsOf: URL(fileURLWithPath: storePath)),
           let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        {
            if decoded.keys.contains("main") { return "main" }

            let sorted = decoded.sorted { a, b -> Bool in
                let lhs = a.value.updatedAt ?? 0
                let rhs = b.value.updatedAt ?? 0
                return lhs > rhs
            }
            if let first = sorted.first { return first.key }
        }
        return "+1003"
    }

    func close() {
        self.windowController?.shutdown()
        self.windowController?.close()
        self.windowController = nil

        self.panelController?.shutdown()
        self.panelController?.close()
        self.panelController = nil
    }

    private func panelHidden() {
        self.onPanelVisibilityChanged?(false)
        self.panelController = nil
    }
}

// MARK: - Port forwarding tunnel

final class WebChatTunnel {
    let process: Process
    let localPort: UInt16?

    private init(process: Process, localPort: UInt16?) {
        self.process = process
        self.localPort = localPort
    }

    deinit {
        self.process.terminate()
    }

    func terminate() {
        if self.process.isRunning {
            self.process.terminate()
            self.process.waitUntilExit()
        }
    }

    static func create(remotePort: Int, preferredLocalPort: UInt16? = nil) async throws -> WebChatTunnel {
        let settings = CommandResolver.connectionSettings()
        guard settings.mode == .remote, let parsed = CommandResolver.parseSSHTarget(settings.target) else {
            throw NSError(domain: "WebChat", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote not configured"])
        }

        let localPort = try await Self.findPort(preferred: preferredLocalPort)
        var args: [String] = [
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-N",
            "-L", "\(localPort):127.0.0.1:\(remotePort)",
        ]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        let identity = settings.identity.trimmingCharacters(in: .whitespacesAndNewlines)
        if !identity.isEmpty { args.append(contentsOf: ["-i", identity]) }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        args.append(userHost)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args
        let pipe = Pipe()
        process.standardError = pipe
        // Consume stderr so ssh cannot block if it logs
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty,
                  let line = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !line.isEmpty else { return }
            webChatLogger.error("webchat tunnel stderr: \(line, privacy: .public)")
        }
        try process.run()

        return WebChatTunnel(process: process, localPort: localPort)
    }

    private static func findPort(preferred: UInt16?) async throws -> UInt16 {
        if let preferred, portIsFree(preferred) { return preferred }

        return try await withCheckedThrowingContinuation { cont in
            let queue = DispatchQueue(label: "com.steipete.clawdis.webchat.port", qos: .utility)
            do {
                let listener = try NWListener(using: .tcp, on: .any)
                listener.newConnectionHandler = { connection in connection.cancel() }
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let port = listener.port?.rawValue {
                            listener.stateUpdateHandler = nil
                            listener.cancel()
                            cont.resume(returning: port)
                        }
                    case let .failed(error):
                        listener.stateUpdateHandler = nil
                        listener.cancel()
                        cont.resume(throwing: error)
                    default:
                        break
                    }
                }
                listener.start(queue: queue)
            } catch {
                cont.resume(throwing: error)
            }
        }
    }

    private static func portIsFree(_ port: UInt16) -> Bool {
        do {
            let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
            listener.cancel()
            return true
        } catch {
            return false
        }
    }
}

extension URL {
    func appending(queryItems: [URLQueryItem]) -> URL {
        guard var comps = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return self }
        comps.queryItems = (comps.queryItems ?? []) + queryItems
        return comps.url ?? self
    }
}
