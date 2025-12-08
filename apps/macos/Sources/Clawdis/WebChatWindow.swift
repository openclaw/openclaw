import AppKit
import Foundation
import OSLog
import WebKit

private let webChatLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

final class WebChatWindowController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    private let webView: WKWebView
    private let sessionKey: String
    private let initialMessagesJSON: String
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

    init(sessionKey: String) {
        webChatLogger.debug("init WebChatWindowController sessionKey=\(sessionKey, privacy: .public)")
        self.sessionKey = sessionKey
        self.initialMessagesJSON = WebChatWindowController.loadInitialMessagesJSON(for: sessionKey)

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Inject callback receiver stub
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
        const __origConsoleLog = console.log;
        console.log = function(...args) {
          try { window.__clawdisLog(args.join(' ')); } catch (_) {}
          __origConsoleLog.apply(console, args);
        };
        window.addEventListener('error', (e) => {
          try {
            window.__clawdisLog(`page error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
          } catch (_) {}
        });
        window.addEventListener('unhandledrejection', (e) => {
          try {
            window.__clawdisLog(`unhandled rejection: ${e.reason}`);
          } catch (_) {}
        });
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
        self.loadPage()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func loadPage() {
        webChatLogger.debug("loadPage begin")
        guard let webChatURL = Bundle.main.url(forResource: "WebChat", withExtension: nil),
              let htmlURL = URL(string: "index.html")
        else {
            NSLog("WebChat resources missing")
            webChatLogger.error("WebChat resources missing in bundle")
            return
        }

        let bootstrapScript = """
        window.__clawdisBootstrap = {
          sessionKey: "\(self.sessionKey)",
          initialMessages: \(self.initialMessagesJSON)
        };
        """
        let userScript = WKUserScript(
            source: bootstrapScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        self.webView.configuration.userContentController.addUserScript(userScript)

        WebChatServer.shared.start(root: webChatURL)
        guard let baseURL = self.waitForWebChatServer() else {
            webChatLogger.error("WebChatServer not ready; cannot load web chat")
            return
        }
        let url = baseURL.appendingPathComponent(htmlURL.relativePath)
        self.webView.load(URLRequest(url: url))
        webChatLogger.debug("loadPage queued HTML into WKWebView url=\(url.absoluteString, privacy: .public)")
    }

    private func waitForWebChatServer(timeout: TimeInterval = 2.0) -> URL? {
        let deadline = Date().addingTimeInterval(timeout)
        var base: URL?
        while Date() < deadline {
            if let url = WebChatServer.shared.baseURL() {
                base = url
                break
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if base == nil {
            webChatLogger.error("WebChatServer failed to become ready within \(timeout, privacy: .public)s")
        }
        return base
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webChatLogger.debug("didFinish navigation url=\(webView.url?.absoluteString ?? "nil", privacy: .public)")
        webView.evaluateJavaScript("document.body.innerText") { result, error in
            if let error {
                webChatLogger.error("eval error: \(error.localizedDescription, privacy: .public)")
            } else if let text = result as? String {
                webChatLogger.debug("body text snapshot: \(String(text.prefix(200)), privacy: .public)")
            }
        }
        webView.evaluateJavaScript("document.readyState") { result, _ in
            if let state = result as? String {
                webChatLogger.debug("readyState=\(state, privacy: .public)")
            }
        }
        webView.evaluateJavaScript("window.location.href") { result, _ in
            if let href = result as? String {
                webChatLogger.debug("js location=\(href, privacy: .public)")
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        webChatLogger.debug("didStartProvisional url=\(webView.url?.absoluteString ?? "nil", privacy: .public)")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        webChatLogger.debug("didCommit url=\(webView.url?.absoluteString ?? "nil", privacy: .public)")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error)
    {
        webChatLogger.error("didFailProvisional error=\(error.localizedDescription, privacy: .public)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        webChatLogger.error("didFail error=\(error.localizedDescription, privacy: .public)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webChatLogger.error("webContentProcessDidTerminate")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String
        else { return }

        if id == "log" {
            if let log = body["log"] as? String {
                webChatLogger.debug("JS: \(log, privacy: .public)")
            }
            return
        }

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
        let result = await AgentRPC.shared.send(
            text: text,
            thinking: "default",
            session: sessionKey,
            deliver: false,
            to: sessionKey)
        return (result.text, result.error)
    }

    private static func loadInitialMessagesJSON(for sessionKey: String) -> String {
        // Prefer remote session log when running in remote mode; fall back to local files.
        var content: String?

        if self.connectionModeIsRemote() {
            if let remote = self.fetchRemoteSessionLog(sessionKey: sessionKey) {
                content = remote
            }
        } else if let sessionId = self.sessionId(for: sessionKey) {
            let primary = self.expand("~/.clawdis/sessions/\(sessionId).jsonl")
            let legacy = self.expand("~/.tau/agent/sessions/clawdis/\(sessionId).jsonl")
            if FileManager.default.fileExists(atPath: primary),
               let text = try? String(contentsOfFile: primary, encoding: .utf8)
            {
                content = text
            } else if FileManager.default.fileExists(atPath: legacy),
                      let text = try? String(contentsOfFile: legacy, encoding: .utf8)
            {
                content = text
            }
        }

        guard let content else { return "[]" }

        var messages: [[String: Any]] = []
        for line in content.split(whereSeparator: { $0.isNewline }) {
            guard let data = String(line).data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            let message = (obj["message"] as? [String: Any]) ?? obj
            guard let role = message["role"] as? String,
                  ["user", "assistant", "system"].contains(role)
            else { continue }

            var contentPayload = message["content"] as? [[String: Any]]
            if contentPayload == nil, let text = message["text"] as? String {
                contentPayload = [["type": "text", "text": text]]
            }
            guard let finalContent = contentPayload else { continue }
            messages.append(["role": role, "content": finalContent])
        }

        guard let data = try? JSONSerialization.data(withJSONObject: messages, options: []) else {
            return "[]"
        }
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    private static func sessionId(for key: String) -> String? {
        let storePath = self.expand("~/.clawdis/sessions/sessions.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: storePath)) else { return nil }
        guard let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard let entry = decoded[key] as? [String: Any] else { return nil }
        return entry["sessionId"] as? String
    }

    // MARK: - Remote session helpers

    private static func connectionModeIsRemote() -> Bool {
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey) ?? "local"
        return modeRaw == AppState.ConnectionMode.remote.rawValue
    }

    private static func remoteSettings() -> (target: String, identity: String)? {
        guard self.connectionModeIsRemote() else { return nil }
        let rawTarget = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        let target = VoiceWakeForwarder.sanitizedTarget(rawTarget)
        let identity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        return (target: target, identity: identity)
    }

    private struct SessionsSummary: Decodable {
        struct Entry: Decodable {
            let key: String
            let sessionId: String?
        }

        let path: String
        let sessions: [Entry]
    }

    private static func remoteSessionsSummary() -> SessionsSummary? {
        guard let jsonData = self.runClawdisCommand(subcommand: "sessions", args: ["--json"]) else {
            webChatLogger.error("remote sessions summary command failed")
            return nil
        }
        if let decoded = try? JSONDecoder().decode(SessionsSummary.self, from: jsonData) {
            return decoded
        }
        if let text = String(data: jsonData, encoding: .utf8) {
            webChatLogger.error("failed to decode sessions summary json=\(text, privacy: .public)")
        }
        return nil
    }

    private static func runClawdisCommand(subcommand: String, args: [String]) -> Data? {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")

        let command = CommandResolver.clawdisCommand(subcommand: subcommand, extraArgs: args)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.first ?? "/usr/bin/env")
        process.arguments = Array(command.dropFirst())
        process.currentDirectoryURL = URL(fileURLWithPath: CommandResolver.projectRootPath())
        process.environment = env

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        do { try process.run() } catch {
            webChatLogger.error("clawdis \(subcommand) failed to launch: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        process.waitUntilExit()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        if !data.isEmpty { return data }
        let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        webChatLogger.error("clawdis \(subcommand) produced no output: \(msg, privacy: .public)")
        return nil
    }

    private static func remoteSessionId(for key: String) -> String? {
        if let summary = self.remoteSessionsSummary(),
           let entry = summary.sessions.first(where: { $0.key == key }),
           let sessionId = entry.sessionId
        {
            return sessionId
        }
        return self.remoteSessionsSummary()?.sessions.first?.sessionId
    }

    private static func readRemoteFile(_ path: String) -> Data? {
        guard let settings = self.remoteSettings(),
              let parsed = VoiceWakeForwarder.parse(target: settings.target)
        else { return nil }

        var sshArgs: [String] = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]
        if parsed.port > 0 { sshArgs.append(contentsOf: ["-p", String(parsed.port)]) }
        let identity = settings.identity.trimmingCharacters(in: .whitespacesAndNewlines)
        if !identity.isEmpty { sshArgs.append(contentsOf: ["-i", identity]) }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        sshArgs.append(userHost)

        // Avoid single-quoting to preserve $HOME expansion; escape double quotes instead.
        let escapedPath = path.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "cat \"\(escapedPath)\""

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = sshArgs + ["/bin/sh", "-c", script]
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        do { try process.run() } catch { return nil }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            webChatLogger.error("ssh cat failed status=\(process.terminationStatus, privacy: .public) stderr=\(stderr, privacy: .public)")
            return nil
        }
        return out.fileHandleForReading.readDataToEndOfFile()
    }

    private static func fetchRemoteSessionLog(sessionKey: String) -> String? {
        guard let summary = self.remoteSessionsSummary() else {
            webChatLogger.error("remote sessions summary missing")
            return nil
        }

        let sessionId = summary.sessions.first(where: { $0.key == sessionKey })?.sessionId
            ?? summary.sessions.first?.sessionId
        guard let sessionId else {
            webChatLogger.error("remote session id missing for key=\(sessionKey, privacy: .public)")
            return nil
        }

        // Prefer the path reported by the CLI; replace trailing sessions.json with the log file.
        let basePath = summary.path
        let logPath: String = if basePath.hasSuffix("sessions.json") {
            String(basePath.dropLast("sessions.json".count)) + "\(sessionId).jsonl"
        } else {
            basePath + "/\(sessionId).jsonl"
        }

        if let data = self.readRemoteFile(logPath), let text = String(data: data, encoding: .utf8) {
            return text
        }

        // Legacy path fallback if the CLI reports a different store.
        let legacy = "$HOME/.tau/agent/sessions/clawdis/\(sessionId).jsonl"
        if let data = self.readRemoteFile(legacy), let text = String(data: data, encoding: .utf8) {
            return text
        }

        webChatLogger.error("remote session log not found at \(logPath, privacy: .public)")
        return nil
    }

    private static func expand(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()
    private var window: WebChatWindowController?
    private var webView: WKWebView? { self.window?.value(forKey: "webView") as? WKWebView }

    func show(sessionKey: String) {
        if self.window == nil {
            self.window = WebChatWindowController(sessionKey: sessionKey)
        }
        self.window?.showWindow(nil)
        self.window?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Send a message into the active web chat session. Returns true if enqueued.
    func sendMessage(_ text: String, thinking: String = "default", sessionKey: String = "main") -> Bool {
        self.show(sessionKey: sessionKey)
        guard let webView else { return false }
        guard let script = try? JSONSerialization.data(withJSONObject: [
            "text": text,
            "thinking": thinking,
        ]) else { return false }

        let payload = String(data: script, encoding: .utf8) ?? ""
        let js = "window.__clawdisEnqueueOutgoing(\(payload))"

        var success = false
        webView.evaluateJavaScript(js) { result, error in
            if error == nil { success = true }
            if let err = error {
                webChatLogger.error("enqueue JS error: \(err.localizedDescription, privacy: .public)")
            } else if let res = result {
                webChatLogger.debug("enqueue JS result: \(String(describing: res), privacy: .public)")
            }
        }
        return success
    }
}
