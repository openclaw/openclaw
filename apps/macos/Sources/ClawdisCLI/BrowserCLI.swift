import Darwin
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

        do {
            switch sub {
            case "status":
                self.printResult(
                    jsonOutput: jsonOutput,
                    res: try await self.httpJSON(method: "GET", url: baseURL.appendingPathComponent("/")))
                return 0

            case "start":
                self.printResult(
                    jsonOutput: jsonOutput,
                    res: try await self.httpJSON(method: "POST", url: baseURL.appendingPathComponent("/start"), timeoutInterval: 15.0))
                return 0

            case "stop":
                self.printResult(
                    jsonOutput: jsonOutput,
                    res: try await self.httpJSON(method: "POST", url: baseURL.appendingPathComponent("/stop"), timeoutInterval: 15.0))
                return 0

            case "tabs":
                let res = try await self.httpJSON(method: "GET", url: baseURL.appendingPathComponent("/tabs"), timeoutInterval: 3.0)
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
                        body: ["url": url],
                        timeoutInterval: 15.0))
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
                        body: ["targetId": id],
                        timeoutInterval: 5.0))
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
                        url: baseURL.appendingPathComponent("/tabs/\(id)"),
                        timeoutInterval: 5.0))
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
                let res = try await self.httpJSON(method: "GET", url: url, timeoutInterval: 20.0)
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
        } catch {
            let msg = self.describeError(error, baseURL: baseURL)
            if jsonOutput {
                self.printJSON(ok: false, result: ["error": msg])
            } else {
                fputs("\(msg)\n", stderr)
            }
            return 1
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

    private static func httpJSON(
        method: String,
        url: URL,
        body: [String: Any]? = nil,
        timeoutInterval: TimeInterval = 2.0
    ) async throws -> [String: Any] {
        var req = URLRequest(url: url, timeoutInterval: timeoutInterval)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw self.wrapNetworkError(error, url: url, timeoutInterval: timeoutInterval)
        }
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

    private static func describeError(_ error: Error, baseURL: URL) -> String {
        let ns = error as NSError
        let msg = ns.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if !msg.isEmpty { return msg }
        return "Browser request failed (\(baseURL.absoluteString))"
    }

    private static func wrapNetworkError(_ error: Error, url: URL, timeoutInterval: TimeInterval) -> Error {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            // Keep this short: this often shows up inside SSH output and agent logs.
            switch ns.code {
            case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
                 NSURLErrorCannotFindHost, NSURLErrorNotConnectedToInternet, NSURLErrorDNSLookupFailed:
                let base = url.absoluteString
                let hint = """
                Can't reach the clawd browser control server at \(base).
                Start (or restart) the Clawdis gateway (Clawdis.app menubar, or `clawdis gateway`) and try again.
                """
                return NSError(domain: "BrowserCLI", code: ns.code, userInfo: [
                    NSLocalizedDescriptionKey: hint,
                ])
            default:
                break
            }
        }
        let base = url.absoluteString
        let generic = "Failed to reach \(base) (timeout \(Int(timeoutInterval))s)."
        return NSError(domain: "BrowserCLI", code: ns.code, userInfo: [
            NSLocalizedDescriptionKey: generic,
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

    private static func formatTabs(res: [String: Any]) -> [String] {
        guard let tabs = res["tabs"] as? [[String: Any]], !tabs.isEmpty else { return [] }
        var lines: [String] = []
        lines.reserveCapacity(tabs.count * 2)
        for tab in tabs {
            let id = (tab["targetId"] as? String) ?? ""
            let title = (tab["title"] as? String) ?? ""
            let url = (tab["url"] as? String) ?? ""
            let shortId = id.isEmpty ? "" : String(id.prefix(8))
            lines.append("- \(shortId)  \(title)  \(url)")
            if !id.isEmpty {
                lines.append("  id: \(id)")
            }
        }
        return lines
    }

    private static func printTabs(res: [String: Any]) {
        let running = (res["running"] as? Bool) ?? false
        print("Running: \(running)")
        for line in self.formatTabs(res: res) {
            print(line)
        }
    }

#if SWIFT_PACKAGE
    static func _testFormatTabs(res: [String: Any]) -> [String] {
        self.formatTabs(res: res)
    }
#endif

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
