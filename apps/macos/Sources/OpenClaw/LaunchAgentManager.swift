import Foundation

enum LaunchAgentManager {
    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.mac.plist")
    }

    static func status() async -> Bool {
        guard FileManager().fileExists(atPath: self.plistURL.path) else { return false }
        let result = await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"])
        return result == 0
    }

    static func set(enabled: Bool, bundlePath: String) async {
        if enabled {
            self.writePlist(bundlePath: bundlePath)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            _ = await self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            _ = await self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"])
        } else {
            // Disable autostart going forward but leave the current app running.
            // bootout would terminate the launchd job immediately (and crash the app if launched via agent).
            try? FileManager().removeItem(at: self.plistURL)
        }
    }

    private static func writePlist(bundlePath: String) {
        let plist = self.plistContents(bundlePath: bundlePath)
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    static func plistContents(bundlePath: String) -> String {
        let environmentXML = self.environmentVariablesXML()
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>ai.openclaw.mac</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(self.plistEscaped("\(bundlePath)/Contents/MacOS/OpenClaw"))</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(self.plistEscaped(FileManager().homeDirectoryForCurrentUser.path))</string>
          <key>RunAtLoad</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>\(environmentXML)
          </dict>
          <key>StandardOutPath</key>
          <string>\(self.plistEscaped(LogLocator.launchdLogPath))</string>
          <key>StandardErrorPath</key>
          <string>\(self.plistEscaped(LogLocator.launchdLogPath))</string>
        </dict>
        </plist>
        """
    }

    private static func environmentVariablesXML() -> String {
        var env: [(String, String)] = [
            ("PATH", CommandResolver.preferredPaths().joined(separator: ":")),
        ]
        for key in ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] {
            if let value = OpenClawEnv.path(key) {
                env.append((key, value))
            }
        }
        return env
            .map { key, value in
                "\n            <key>\(self.plistEscaped(key))</key>\n            <string>\(self.plistEscaped(value))</string>"
            }
            .joined()
    }

    private static func plistEscaped(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) async -> Int32 {
        await Task.detached(priority: .utility) { () -> Int32 in
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                _ = try process.runAndReadToEnd(from: pipe)
                return process.terminationStatus
            } catch {
                return -1
            }
        }.value
    }
}
