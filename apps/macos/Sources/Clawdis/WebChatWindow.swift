import AppKit
import Foundation
import Network
import OSLog
import WebKit

private let webChatLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

@MainActor
final class WebChatWindowController: NSWindowController, WKNavigationDelegate {
    private let webView: WKWebView
    private let sessionKey: String
    private var tunnel: WebChatTunnel?
    private var baseEndpoint: URL?
    private let remotePort: Int
    private var reachabilityTask: Task<Void, Never>?
    private var tunnelRestartEnabled = false

    init(sessionKey: String) {
        webChatLogger.debug("init WebChatWindowController sessionKey=\(sessionKey, privacy: .public)")
        self.sessionKey = sessionKey
        self.remotePort = AppStateStore.webChatPort

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        self.webView = WKWebView(frame: .zero, configuration: config)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false)
        window.title = "Clawd Web Chat"
        window.contentView = self.webView
        super.init(window: window)
        self.webView.navigationDelegate = self

        self.loadPlaceholder()
        Task { await self.bootstrap() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @MainActor deinit {
        self.reachabilityTask?.cancel()
        self.stopTunnel(allowRestart: false)
    }

    private func loadPlaceholder() {
        let html = """
        <html><body style='font-family:-apple-system;padding:24px;color:#888'>Connecting to web chat…</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    private func loadPage(baseURL: URL) {
        self.webView.load(URLRequest(url: baseURL))
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
            try await self.startOrRestartTunnel()
        } else {
            URL(string: "http://127.0.0.1:\(remotePort)/")!
        }
    }

    private func loadWebChat(baseEndpoint: URL) {
        var comps = URLComponents(url: baseEndpoint.appendingPathComponent("webchat/"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "session", value: self.sessionKey)]
        guard let url = comps?.url else {
            self.showError("invalid webchat url")
            return
        }
        self.loadPage(baseURL: url)
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

    private func showError(_ text: String) {
        let html = """
        <html><body style='font-family:-apple-system;padding:24px;color:#c00'>Web chat failed to connect.<br><br>\(
            text)</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    func shutdown() {
        self.reachabilityTask?.cancel()
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
}

// MARK: - Manager

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()
    private var controller: WebChatWindowController?

    func show(sessionKey: String) {
        if self.controller == nil {
            self.controller = WebChatWindowController(sessionKey: sessionKey)
        }
        self.controller?.showWindow(nil)
        self.controller?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        self.controller?.shutdown()
        self.controller?.close()
        self.controller = nil
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
