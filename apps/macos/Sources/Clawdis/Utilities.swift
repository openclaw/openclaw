import AppKit
import Foundation

enum LaunchdManager {
    private static func runLaunchctl(_ args: [String]) {
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = args
        try? process.run()
    }

    static func startClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["kickstart", "-k", userTarget])
    }

    static func stopClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["stop", userTarget])
    }
}

enum LaunchAgentManager {
    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.steipete.clawdis.plist")
    }

    static func status() -> Bool {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return false }
        let result = self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"])
        return result == 0
    }

    static func set(enabled: Bool, bundlePath: String) {
        if enabled {
            self.writePlist(bundlePath: bundlePath)
            _ = self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            _ = self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            _ = self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"])
        } else {
            _ = self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            try? FileManager.default.removeItem(at: self.plistURL)
        }
    }

    private static func writePlist(bundlePath: String) {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.steipete.clawdis</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(bundlePath)/Contents/MacOS/Clawdis</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager.default.homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>MachServices</key>
          <dict>
            <key>com.steipete.clawdis.xpc</key>
            <true/>
          </dict>
          <key>StandardOutPath</key>
          <string>/tmp/clawdis.log</string>
          <key>StandardErrorPath</key>
          <string>/tmp/clawdis.log</string>
        </dict>
        </plist>
        """
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) -> Int32 {
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = args
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try? process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

@MainActor
enum CLIInstaller {
    static func installedLocation() -> String? {
        let fm = FileManager.default

        for basePath in cliHelperSearchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("clawdis-mac").path
            var isDirectory: ObjCBool = false

            guard fm.fileExists(atPath: candidate, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }

            if fm.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func install(statusHandler: @escaping @Sendable (String) async -> Void) async {
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ClawdisCLI")
        guard FileManager.default.isExecutableFile(atPath: helper.path) else {
            await statusHandler("Helper missing in bundle; rebuild via scripts/package-mac-app.sh")
            return
        }

        let targets = cliHelperSearchPaths.map { "\($0)/clawdis-mac" }
        let result = await self.privilegedSymlink(source: helper.path, targets: targets)
        await statusHandler(result)
    }

    private static func privilegedSymlink(source: String, targets: [String]) async -> String {
        let escapedSource = self.shellEscape(source)
        let targetList = targets.map(self.shellEscape).joined(separator: " ")
        let cmds = [
            "mkdir -p /usr/local/bin /opt/homebrew/bin",
            targets.map { "ln -sf \(escapedSource) \($0)" }.joined(separator: "; ")
        ].joined(separator: "; ")

        let script = """
        do shell script "\(cmds)" with administrator privileges
        """

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if proc.terminationStatus == 0 {
                return output.isEmpty ? "CLI helper linked into \(targetList)" : output
            }
            if output.lowercased().contains("user canceled") {
                return "Install canceled"
            }
            return "Failed to install CLI helper: \(output)"
        } catch {
            return "Failed to run installer: \(error.localizedDescription)"
        }
    }

    private static func shellEscape(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

enum CommandResolver {
    private static let projectRootDefaultsKey = "clawdis.relayProjectRootPath"

    static func projectRoot() -> URL {
        if let stored = UserDefaults.standard.string(forKey: self.projectRootDefaultsKey),
           let url = self.expandPath(stored) {
            return url
        }
        let fallback = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Projects/clawdis")
        if FileManager.default.fileExists(atPath: fallback.path) {
            return fallback
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static func setProjectRoot(_ path: String) {
        UserDefaults.standard.set(path, forKey: self.projectRootDefaultsKey)
    }

    static func projectRootPath() -> String {
        self.projectRoot().path
    }

    static func preferredPaths() -> [String] {
        let current = ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":").map(String.init) ?? []
        let extras = [
            self.projectRoot().appendingPathComponent("node_modules/.bin").path,
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/pnpm").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        var seen = Set<String>()
        return (extras + current).filter { seen.insert($0).inserted }
    }

    static func findExecutable(named name: String) -> String? {
        for dir in self.preferredPaths() {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func clawdisCommand(subcommand: String, extraArgs: [String] = []) -> [String] {
        if let clawdisPath = self.findExecutable(named: "clawdis") {
            return [clawdisPath, subcommand] + extraArgs
        }
        if let node = self.findExecutable(named: "node") {
            let cli = self.projectRoot().appendingPathComponent("bin/clawdis.js").path
            if FileManager.default.isReadableFile(atPath: cli) {
                return [node, cli, subcommand] + extraArgs
            }
        }
        if let pnpm = self.findExecutable(named: "pnpm") {
            return [pnpm, "clawdis", subcommand] + extraArgs
        }
        return ["clawdis", subcommand] + extraArgs
    }

    private static func expandPath(_ path: String) -> URL? {
        var expanded = path
        if expanded.hasPrefix("~") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            expanded.replaceSubrange(expanded.startIndex...expanded.startIndex, with: home)
        }
        return URL(fileURLWithPath: expanded)
    }
}
