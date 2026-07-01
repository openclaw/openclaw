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
        let plist: [String: Any] = [
            "Label": "ai.openclaw.mac",
            "ProgramArguments": [
                "\(bundlePath)/Contents/MacOS/OpenClaw",
            ],
            "WorkingDirectory": FileManager().homeDirectoryForCurrentUser.path,
            "RunAtLoad": true,
            "EnvironmentVariables": self.launchEnvironmentVariables(),
            "StandardOutPath": LogLocator.launchdLogPath,
            "StandardErrorPath": LogLocator.launchdLogPath,
        ]
        guard
            let data = try? PropertyListSerialization.data(
                fromPropertyList: plist,
                format: .xml,
                options: 0),
            let contents = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        return contents
    }

    private static func launchEnvironmentVariables() -> [String: String] {
        var environment = [
            "PATH": CommandResolver.preferredPaths().joined(separator: ":"),
        ]
        for key in ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] {
            if let value = OpenClawEnv.path(key) {
                environment[key] = value
            }
        }
        return environment
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
