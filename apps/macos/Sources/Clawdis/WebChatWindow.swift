import AppKit
import Foundation
import OSLog
import WebKit

private let webChatLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")

final class WebChatWindowController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    private let webView: WKWebView
    private let sessionKey: String
    private let initialMessagesJSON: String

    init(sessionKey: String) {
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
    required init?(coder: NSCoder) { fatalError() }

    private func loadPage() {
        let messagesJSON = self.initialMessagesJSON.replacingOccurrences(of: "</script>", with: "<\\/script>")
        guard let webChatURL = Bundle.main.url(forResource: "WebChat", withExtension: nil) else {
            NSLog("WebChat resources missing")
            return
        }

        let distPath = webChatURL.path(percentEncoded: false)
        let cssPath = webChatURL.appendingPathComponent("app.css").path(percentEncoded: false)
        let vendor = webChatURL.appendingPathComponent("vendor")

        let piAi = vendor.appendingPathComponent("pi-ai/index.js").path(percentEncoded: false)
        let miniLit = vendor.appendingPathComponent("mini-lit/index.js").path(percentEncoded: false)
        let lit = vendor.appendingPathComponent("lit/index.js").path(percentEncoded: false)
        let lucide = vendor.appendingPathComponent("lucide/lucide.js").path(percentEncoded: false)
        let pdfjs = vendor.appendingPathComponent("pdfjs-dist/build/pdf.js").path(percentEncoded: false)
        let pdfWorker = vendor.appendingPathComponent("pdfjs-dist/build/pdf.worker.min.mjs").path(percentEncoded: false)

        let importMap = [
            "imports": [
                "@mariozechner/pi-web-ui": "file://\(distPath)/index.js",
                "@mariozechner/pi-web-ui/": "file://\(distPath)/",
                "@mariozechner/pi-ai": "file://\(piAi)",
                "@mariozechner/pi-ai/": "file://\(vendor.appendingPathComponent("pi-ai/").path(percentEncoded: false))",
                "@mariozechner/mini-lit": "file://\(miniLit)",
                "@mariozechner/mini-lit/": "file://\(vendor.appendingPathComponent("mini-lit/").path(percentEncoded: false))",
                "lit": "file://\(lit)",
                "lit/": "file://\(vendor.appendingPathComponent("lit/").path(percentEncoded: false))",
                "lucide": "file://\(lucide)",
                "pdfjs-dist": "file://\(pdfjs)",
                "pdfjs-dist/": "file://\(vendor.appendingPathComponent("pdfjs-dist/").path(percentEncoded: false))",
                "pdfjs-dist/build/pdf.worker.min.mjs": "file://\(pdfWorker)",
            ],
        ]

        let importMapJSON: String = if let data = try? JSONSerialization.data(
            withJSONObject: importMap,
            options: [.prettyPrinted]),
            let json = String(data: data, encoding: .utf8)
        {
            json
        } else {
            "{}"
        }

        let html = """
        <!doctype html>
        <html>
        <head>
          <meta charset='utf-8'>
          <title>Clawd Web Chat</title>
          <link rel='stylesheet' href='file://\(cssPath)'>
          <script type="importmap">
          \(importMapJSON)
          </script>
          <style>html,body{height:100%;margin:0;padding:0;}#app{height:100%;}</style>
        </head>
        <body>
          <div id="app"></div>
          <script type="module">
            const initialMessages = \(messagesJSON);
            const status = (msg) => {
              console.log(msg);
              window.__clawdisLog(msg);
              const el = document.getElementById('app');
              if (el && !el.dataset.booted) {
                el.textContent = msg;
              }
            };

            status('boot: starting imports');

            (async () => {
              try {
                const { Agent, ChatPanel, AppStorage, setAppStorage } = await import('@mariozechner/pi-web-ui');
                status('boot: pi-web-ui imported');
                const { getModel } = await import('@mariozechner/pi-ai');
                status('boot: pi-ai imported');

                class NativeTransport {
                  async *run(messages, userMessage, cfg, signal) {
                    const result = await window.__clawdisSend({ type: 'chat', payload: { text: userMessage.content?.[0]?.text ?? '', sessionKey: '\(
                        sessionKey)' } });
                    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
                    const assistant = {
                      role: 'assistant',
                      content: [{ type: 'text', text: result.text ?? '' }],
                      api: cfg.model.api,
                      provider: cfg.model.provider,
                      model: cfg.model.id,
                      usage,
                      stopReason: 'stop',
                      timestamp: Date.now()
                    };
                    yield { type: 'turn_start' };
                    yield { type: 'message_start', message: assistant };
                    yield { type: 'message_end', message: assistant };
                    yield { type: 'turn_end' };
                    yield { type: 'agent_end' };
                  }
                }

                // Minimal storage
                const storage = new AppStorage();
                setAppStorage(storage);

                const agent = new Agent({
                  initialState: {
                    systemPrompt: 'You are Clawd (primary session).',
                    model: getModel('anthropic', 'claude-opus-4-5'),
                    thinkingLevel: 'off',
                    messages: initialMessages
                  },
                  transport: new NativeTransport()
                });

                // Patch prompt to append user message into history first
                const origPrompt = agent.prompt.bind(agent);
                agent.prompt = async (input, attachments) => {
                  const userMessage = {
                    role: 'user',
                    content: [{ type: 'text', text: input }],
                    attachments: attachments?.length ? attachments : undefined,
                    timestamp: Date.now()
                  };
                  agent.appendMessage(userMessage);
                  return origPrompt(input, attachments);
                };

                const panel = new ChatPanel();
                panel.style.height = '100%';
                panel.style.display = 'block';
                await panel.setAgent(agent);
                const mount = document.getElementById('app');
                mount.dataset.booted = '1';
                mount.textContent = '';
                mount.appendChild(panel);
                status('boot: ready');
              } catch (err) {
                const msg = err?.stack || err?.message || String(err);
                window.__clawdisLog(msg);
                document.body.style.color = '#e06666';
                document.body.style.fontFamily = 'monospace';
                document.body.style.padding = '16px';
                document.body.innerText = 'Web chat failed to load:\\n' + msg;
              }
            })();
          </script>
        </body>
        </html>
        """
        self.webView.loadHTMLString(html, baseURL: webChatURL)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body.innerText") { result, error in
            if let error {
                webChatLogger.error("eval error: \(error.localizedDescription, privacy: .public)")
            } else if let text = result as? String {
                webChatLogger.debug("body text snapshot: \(String(text.prefix(200)), privacy: .public)")
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let type = body["type"] as? String
        else { return }

        if id == "log", let log = body["log"] as? String {
            webChatLogger.debug("JS: \(log, privacy: .public)")
            return
        }

        guard type == "chat",
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
        let data: Data
        do {
            data = try await Task.detached(priority: .utility) { () -> Data in
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["pnpm", "clawdis", "agent", "--to", sessionKey, "--message", text, "--json"]
                process.currentDirectoryURL = URL(fileURLWithPath: "/Users/steipete/Projects/clawdis")

                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = Pipe()

                try process.run()
                process.waitUntilExit()
                let out = pipe.fileHandleForReading.readDataToEndOfFile()
                guard process.terminationStatus == 0 else {
                    throw NSError(
                        domain: "ClawdisAgent",
                        code: Int(process.terminationStatus),
                        userInfo: [NSLocalizedDescriptionKey: String(data: out, encoding: .utf8) ?? "unknown error"])
                }
                return out
            }.value
        } catch {
            return (nil, error.localizedDescription)
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let payloads = obj["payloads"] as? [[String: Any]],
           let first = payloads.first,
           let text = first["text"] as? String
        {
            return (text, nil)
        }
        return (String(data: data, encoding: .utf8), nil)
    }

    private static func loadInitialMessagesJSON(for sessionKey: String) -> String {
        guard let sessionId = self.sessionId(for: sessionKey) else { return "[]" }
        let path = self.expand("~/.clawdis/sessions/\(sessionId).jsonl")
        guard FileManager.default.fileExists(atPath: path) else { return "[]" }
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return "[]" }

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

    private static func expand(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()
    private var window: WebChatWindowController?

    func show(sessionKey: String) {
        if self.window == nil {
            self.window = WebChatWindowController(sessionKey: sessionKey)
        }
        self.window?.showWindow(nil)
        self.window?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
