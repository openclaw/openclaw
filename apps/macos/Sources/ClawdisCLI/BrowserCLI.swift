import Foundation

enum BrowserCLI {
    private static let defaultControlURL = "http://127.0.0.1:18791"

    static func run(args: [String], jsonOutput: Bool) async throws -> Int32 {
        var args = args
        guard let sub = args.first else {
            self.printHelp()
            return 0
        }
        args = Array(args.dropFirst())

        if sub == "--help" || sub == "-h" || sub == "help" {
            self.printHelp()
            return 0
        }

        var overrideURL: String?
        var fullPage = false
        var targetId: String?
        var rest: [String] = []

        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--url":
                overrideURL = args.popFirst()
            case "--full-page":
                fullPage = true
            case "--target-id":
                targetId = args.popFirst()
            default:
                rest.append(arg)
            }
        }

        let cfg = self.loadBrowserConfig()
        guard cfg.enabled else {
            if jsonOutput {
                self.printJSON(ok: false, result: ["error": "browser control disabled"])
            } else {
                print("Browser control is disabled in ~/.clawdis/clawdis.json (browser.enabled=false).")
            }
            return 1
        }

        let base = (overrideURL ?? cfg.controlUrl).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let baseURL = URL(string: base) else {
            throw NSError(domain: "BrowserCLI", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid browser control URL: \(base)",
            ])
        }

        switch sub {
        case "status":
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(method: "GET", url: baseURL.appendingPathComponent("/")))
            return 0

        case "start":
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(method: "POST", url: baseURL.appendingPathComponent("/start")))
            return 0

        case "stop":
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(method: "POST", url: baseURL.appendingPathComponent("/stop")))
            return 0

        case "tabs":
            let res = try await self.httpJSON(method: "GET", url: baseURL.appendingPathComponent("/tabs"))
            if jsonOutput {
                self.printJSON(ok: true, result: res)
            } else {
                self.printTabs(res: res)
            }
            return 0

        case "open":
            guard let url = rest.first, !url.isEmpty else {
                self.printHelp()
                return 2
            }
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(
                    method: "POST",
                    url: baseURL.appendingPathComponent("/tabs/open"),
                    body: ["url": url]))
            return 0

        case "focus":
            guard let id = rest.first, !id.isEmpty else {
                self.printHelp()
                return 2
            }
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(
                    method: "POST",
                    url: baseURL.appendingPathComponent("/tabs/focus"),
                    body: ["targetId": id]))
            return 0

        case "close":
            guard let id = rest.first, !id.isEmpty else {
                self.printHelp()
                return 2
            }
            self.printResult(
                jsonOutput: jsonOutput,
                res: try await self.httpJSON(
                    method: "DELETE",
                    url: baseURL.appendingPathComponent("/tabs/\(id)")))
            return 0

        case "screenshot":
            var url = baseURL.appendingPathComponent("/screenshot")
            var items: [URLQueryItem] = []
            if let targetId, !targetId.isEmpty {
                items.append(URLQueryItem(name: "targetId", value: targetId))
            }
            if fullPage {
                items.append(URLQueryItem(name: "fullPage", value: "1"))
            }
            if !items.isEmpty {
                url = self.withQuery(url, items: items)
            }
            let res = try await self.httpJSON(method: "GET", url: url)
            if jsonOutput {
                self.printJSON(ok: true, result: res)
            } else if let path = res["path"] as? String, !path.isEmpty {
                print("MEDIA:\(path)")
            } else {
                self.printResult(jsonOutput: false, res: res)
            }
            return 0

        default:
            self.printHelp()
            return 2
        }
    }

    private struct BrowserConfig {
        let enabled: Bool
        let controlUrl: String
    }

    private static func loadBrowserConfig() -> BrowserConfig {
        let root = self.loadConfigDict()
        let browser = root["browser"] as? [String: Any]
        let enabled = browser?["enabled"] as? Bool ?? true
        let url = (browser?["controlUrl"] as? String) ?? self.defaultControlURL
        return BrowserConfig(enabled: enabled, controlUrl: url)
    }

    private static func loadConfigDict() -> [String: Any] {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private static func withQuery(_ url: URL, items: [URLQueryItem]) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.queryItems = items
        return components.url ?? url
    }

    private static func httpJSON(method: String, url: URL, body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: url, timeoutInterval: 2.0)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }

        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0

        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "BrowserCLI", code: status, userInfo: [
                NSLocalizedDescriptionKey: "HTTP \(status) \(method) \(url): \(text)",
            ])
        }

        if status >= 200 && status < 300 {
            return obj
        }

        let msg = (obj["error"] as? String) ?? "HTTP \(status)"
        throw NSError(domain: "BrowserCLI", code: status, userInfo: [
            NSLocalizedDescriptionKey: msg,
        ])
    }

    private static func printResult(jsonOutput: Bool, res: [String: Any]) {
        if jsonOutput {
            self.printJSON(ok: true, result: res)
            return
        }
        if let text = res["message"] as? String, !text.isEmpty {
            print(text)
        } else {
            print(res)
        }
    }

    private static func printTabs(res: [String: Any]) {
        let running = (res["running"] as? Bool) ?? false
        print("Running: \(running)")
        guard let tabs = res["tabs"] as? [[String: Any]], !tabs.isEmpty else { return }
        for tab in tabs {
            let id = (tab["targetId"] as? String) ?? ""
            let title = (tab["title"] as? String) ?? ""
            let url = (tab["url"] as? String) ?? ""
            let shortId = id.isEmpty ? "" : String(id.prefix(8))
            print("- \(shortId)  \(title)  \(url)")
        }
    }

    private static func printJSON(ok: Bool, result: Any) {
        let obj: [String: Any] = ["ok": ok, "result": result]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]),
           let text = String(data: data, encoding: .utf8)
        {
            print(text)
        } else {
            print("{\"ok\":false,\"error\":\"failed to encode json\"}")
        }
    }

    private static func printHelp() {
        let usage = """
        Browser (clawd) — control clawd’s dedicated Chrome/Chromium via the gateway’s loopback server.

        Usage:
          clawdis-mac browser status [--url <http://127.0.0.1:18791>]
          clawdis-mac browser start [--url <...>]
          clawdis-mac browser stop [--url <...>]
          clawdis-mac browser tabs [--url <...>]
          clawdis-mac browser open <url> [--url <...>]
          clawdis-mac browser focus <targetId> [--url <...>]
          clawdis-mac browser close <targetId> [--url <...>]
          clawdis-mac browser screenshot [--target-id <id>] [--full-page] [--url <...>]

        Notes:
          - Config defaults come from ~/.clawdis/clawdis.json (browser.enabled, browser.controlUrl).
          - `browser screenshot` prints MEDIA:<path> in text mode.
        """
        print(usage)
    }
}
