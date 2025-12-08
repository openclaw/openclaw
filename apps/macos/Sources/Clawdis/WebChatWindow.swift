import AppKit
import Foundation
import Network
import OSLog
import WebKit

import ClawdisIPC

private let webChatLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

private struct WebChatCliInfo: Decodable {
    let port: Int
    let token: String?
    let host: String?
    let basePath: String?
}

final class WebChatWindowController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    private let webView: WKWebView
    private let sessionKey: String
    private var initialMessagesJSON: String = "[]"
    private var tunnel: WebChatTunnel?
    private var baseEndpoint: URL?
    private var apiToken: String?

    init(sessionKey: String) {
        webChatLogger.debug("init WebChatWindowController sessionKey=\(sessionKey, privacy: .public)")
        self.sessionKey = sessionKey

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let callbackScript = """
        window.__clawdisCallbacks = new Map();
        window.__clawdisReceive = function(resp) {
          const entry = window.__clawdisCallbacks.get(resp.id);
          if (!entry) return;
          window.__clawdisCallbacks.delete(resp.id);
          if (resp.ok) {
            entry.resolve(resp.result);
          } else {
            entry.reject(resp.error || 'unknown error');
          }
        };
        window.__clawdisSend = function(payload) {
          const id = crypto.randomUUID();
          return new Promise((resolve, reject) => {
            window.__clawdisCallbacks.set(id, { resolve, reject });
            window.webkit?.messageHandlers?.clawdis?.postMessage({ id, ...payload });
          });
        };
        window.__clawdisLog = function(msg) {
          try {
            window.webkit?.messageHandlers?.clawdis?.postMessage({ id: 'log', log: String(msg) });
          } catch (_) {}
        };
        """
        let userScript = WKUserScript(source: callbackScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)

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
        contentController.add(self, name: "clawdis")

        self.loadPlaceholder()
        Task { await self.bootstrap() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func loadPlaceholder() {
        let html = """
        <html><body style='font-family:-apple-system;padding:24px;color:#888'>Connecting to web chat…</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    private func loadPage(baseURL: URL) {
        let bootstrapScript = """
        window.__clawdisBootstrap = {
          sessionKey: \(self.sessionKey),
          initialMessages: \(self.initialMessagesJSON)
        };
        """
        let userScript = WKUserScript(
            source: bootstrapScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        self.webView.configuration.userContentController.addUserScript(userScript)

        let url = baseURL.appendingPathComponent("index.html")
        self.webView.load(URLRequest(url: url))
        webChatLogger.debug("loadPage url=\(url.absoluteString, privacy: .public)")
    }

    // MARK: - Bootstrap

    private func bootstrap() async {
        do {
            let cliInfo = try await self.fetchWebChatCliInfo()
            guard AppStateStore.webChatEnabled else {
                throw NSError(domain: "WebChat", code: 5, userInfo: [NSLocalizedDescriptionKey: "Web chat disabled in settings"])
            }
            let endpoint = try await self.prepareEndpoint(remotePort: cliInfo.port)
            self.baseEndpoint = endpoint
            let infoURL = endpoint.appendingPathComponent("webchat/info")
                .appending(queryItems: [URLQueryItem(name: "session", value: self.sessionKey)])

            let (data, _) = try await URLSession.shared.data(from: infoURL)
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msgs = obj["initialMessages"]
            {
                if let json = try? JSONSerialization.data(withJSONObject: msgs, options: []) {
                    self.initialMessagesJSON = String(data: json, encoding: .utf8) ?? "[]"
                }
            }
            if let token = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let tk = token["token"] as? String, !tk.isEmpty {
                self.apiToken = tk
            }
            await MainActor.run {
                self.loadPage(baseURL: endpoint.appendingPathComponent("webchat/"))
            }
        } catch {
            let message = error.localizedDescription
            webChatLogger.error("webchat bootstrap failed: \(message, privacy: .public)")
            await MainActor.run { self.showError(message) }
        }
    }

    private func fetchWebChatCliInfo() async throws -> WebChatCliInfo {
        var args = ["--json"]
        let port = AppStateStore.webChatPort
        if port > 0 { args += ["--port", String(port)] }
        let response = await ShellRunner.run(
            command: CommandResolver.clawdisCommand(subcommand: "webchat", extraArgs: args),
            cwd: CommandResolver.projectRootPath(),
            env: nil,
            timeout: 10)
        guard response.ok, let data = response.payload else {
            throw NSError(domain: "WebChat", code: 1, userInfo: [NSLocalizedDescriptionKey: response.message ?? "webchat cli failed"])
        }
        return try JSONDecoder().decode(WebChatCliInfo.self, from: data)
    }

    private func prepareEndpoint(remotePort: Int) async throws -> URL {
        if CommandResolver.connectionModeIsRemote() {
            let tunnel = try await WebChatTunnel.create(remotePort: remotePort)
            self.tunnel = tunnel
            guard let port = tunnel.localPort else {
                throw NSError(domain: "WebChat", code: 2, userInfo: [NSLocalizedDescriptionKey: "tunnel missing port"])
            }
            return URL(string: "http://127.0.0.1:\(port)/")!
        } else {
            return URL(string: "http://127.0.0.1:\(remotePort)/")!
        }
    }

    private func showError(_ text: String) {
        let html = """
        <html><body style='font-family:-apple-system;padding:24px;color:#c00'>Web chat failed to connect.<br><br>\(text)</body></html>
        """
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webChatLogger.debug("didFinish navigation url=\(webView.url?.absoluteString ?? "nil", privacy: .public)")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "clawdis" else { return }
        if let body = message.body as? [String: Any], body["id"] as? String == "log" {
            if let log = body["log"] as? String { webChatLogger.debug("JS: \(log, privacy: .public)") }
            return
        }

        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String
        else { return }

        guard let type = body["type"] as? String,
              type == "chat",
              let payload = body["payload"] as? [String: Any],
              let text = payload["text"] as? String
        else { return }

        Task { @MainActor in
            let reply = await runAgent(text: text, sessionKey: sessionKey)
            let json: [String: Any] = [
                "id": id,
                "ok": reply.error == nil,
                "result": ["text": reply.text ?? ""],
                "error": reply.error ?? NSNull(),
            ]
            if let data = try? JSONSerialization.data(withJSONObject: json),
               let js = String(data: data, encoding: .utf8)
            {
                _ = try? await self.webView.evaluateJavaScript("window.__clawdisReceive(" + js + ")")
            }
        }
    }

    private func runAgent(text: String, sessionKey: String) async -> (text: String?, error: String?) {
        await MainActor.run { AppStateStore.shared.setWorking(true) }
        defer { Task { await MainActor.run { AppStateStore.shared.setWorking(false) } } }
        guard let base = self.baseEndpoint else {
            return (nil, "web chat endpoint missing")
        }
        do {
            var req = URLRequest(url: base.appendingPathComponent("webchat/rpc"))
            req.httpMethod = "POST"
            var headers: [String: String] = ["Content-Type": "application/json"]
            if let apiToken, !apiToken.isEmpty { headers["Authorization"] = "Bearer \(apiToken)" }
            req.allHTTPHeaderFields = headers
            let body: [String: Any] = [
                "text": text,
                "session": sessionKey,
                "thinking": "default",
                "deliver": false,
                "to": sessionKey,
            ]
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, _) = try await URLSession.shared.data(for: req)
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ok = obj["ok"] as? Bool,
               ok == true
            {
                if let payloads = obj["payloads"] as? [[String: Any]],
                   let first = payloads.first,
                   let txt = first["text"] as? String
                {
                    return (txt, nil)
                }
                return (nil, nil)
            }
            let errObj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
            let err = (errObj?["error"] as? String) ?? "rpc failed"
            return (nil, err)
        } catch {
            return (nil, error.localizedDescription)
        }
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

    static func create(remotePort: Int) async throws -> WebChatTunnel {
        let settings = CommandResolver.connectionSettings()
        guard settings.mode == .remote, let parsed = VoiceWakeForwarder.parse(target: settings.target) else {
            throw NSError(domain: "WebChat", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote not configured"])
        }

        let localPort = try Self.findFreePort()
        var args: [String] = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-N", "-L", "\(localPort):127.0.0.1:\(remotePort)"]
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
        try process.run()

        return WebChatTunnel(process: process, localPort: localPort)
    }

    private static func findFreePort() throws -> UInt16 {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.start(queue: .main)
        while listener.port == nil {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        let port = listener.port?.rawValue
        listener.cancel()
        guard let port else { throw NSError(domain: "WebChat", code: 4, userInfo: [NSLocalizedDescriptionKey: "no port"])}
        return port
    }
}

extension URL {
    func appending(queryItems: [URLQueryItem]) -> URL {
        guard var comps = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return self }
        comps.queryItems = (comps.queryItems ?? []) + queryItems
        return comps.url ?? self
    }
}
