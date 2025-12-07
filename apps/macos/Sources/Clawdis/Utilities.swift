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
            // Disable autostart going forward but leave the current app running.
            // bootout would terminate the launchd job immediately (and crash the app if launched via agent).
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
          <key>KeepAlive</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>\(CommandResolver.preferredPaths().joined(separator: ":"))</string>
          </dict>
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

// Human-friendly age string (e.g., "2m ago").
func age(from date: Date, now: Date = .init()) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    let minutes = seconds / 60
    let hours = minutes / 60
    let days = hours / 24

    if seconds < 60 { return "just now" }
    if minutes == 1 { return "1 minute ago" }
    if minutes < 60 { return "\(minutes)m ago" }
    if hours == 1 { return "1 hour ago" }
    if hours < 24 { return "\(hours)h ago" }
    if days == 1 { return "yesterday" }
    return "\(days)d ago"
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
            targets.map { "ln -sf \(escapedSource) \($0)" }.joined(separator: "; "),
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
    private static let helperName = "clawdis"

    private static func bundledRelayRoot() -> URL? {
        guard let resource = Bundle.main.resourceURL else { return nil }
        let relay = resource.appendingPathComponent("Relay")
        return FileManager.default.fileExists(atPath: relay.path) ? relay : nil
    }

    private static func bundledRelayCommand(subcommand: String, extraArgs: [String]) -> [String]? {
        guard let relay = self.bundledRelayRoot() else { return nil }
        let bunPath = relay.appendingPathComponent("bun").path
        let entry = relay.appendingPathComponent("dist/index.js").path
        guard FileManager.default.isExecutableFile(atPath: bunPath),
              FileManager.default.isReadableFile(atPath: entry)
        else { return nil }
        return [bunPath, entry, subcommand] + extraArgs
    }

    static func projectRoot() -> URL {
        if let bundled = self.bundledRelayRoot() {
            return bundled
        }
        if let stored = UserDefaults.standard.string(forKey: self.projectRootDefaultsKey),
           let url = self.expandPath(stored)
        {
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
        var extras = [
            self.projectRoot().appendingPathComponent("node_modules/.bin").path,
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/pnpm").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        if let relay = self.bundledRelayRoot() {
            extras.insert(relay.appendingPathComponent("node_modules/.bin").path, at: 0)
        }
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

    static func clawdisExecutable() -> String? {
        self.findExecutable(named: self.helperName)
    }

    static func nodeCliPath() -> String? {
        let candidate = self.projectRoot().appendingPathComponent("bin/clawdis.js").path
        return FileManager.default.isReadableFile(atPath: candidate) ? candidate : nil
    }

    static func hasAnyClawdisInvoker() -> Bool {
        if self.clawdisExecutable() != nil { return true }
        if self.findExecutable(named: "pnpm") != nil { return true }
        if self.findExecutable(named: "node") != nil, self.nodeCliPath() != nil { return true }
        return false
    }

    static func clawdisCommand(subcommand: String, extraArgs: [String] = []) -> [String] {
        let settings = self.connectionSettings()
        if settings.mode == .remote, let ssh = self.sshCommand(subcommand: subcommand, extraArgs: extraArgs, settings: settings) {
            return ssh
        }
        if let bundled = self.bundledRelayCommand(subcommand: subcommand, extraArgs: extraArgs) {
            return bundled
        }
        if let clawdisPath = self.clawdisExecutable() {
            return [clawdisPath, subcommand] + extraArgs
        }
        if let node = self.findExecutable(named: "node") {
            if let cli = self.nodeCliPath() {
                return [node, cli, subcommand] + extraArgs
            }
        }
        if let pnpm = self.findExecutable(named: "pnpm") {
            // Use --silent to avoid pnpm lifecycle banners that would corrupt JSON outputs.
            return [pnpm, "--silent", "clawdis", subcommand] + extraArgs
        }
        return ["clawdis", subcommand] + extraArgs
    }

    private static func sshCommand(subcommand: String, extraArgs: [String], settings: RemoteSettings) -> [String]? {
        guard !settings.target.isEmpty else { return nil }
        let parsed = VoiceWakeForwarder.parse(target: settings.target)
        guard let parsed else { return nil }

        var args: [String] = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !settings.identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", settings.identity])
        }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        args.append(userHost)

        let quotedArgs = (["clawdis", subcommand] + extraArgs).map(self.shellQuote).joined(separator: " ")
        let cdPrefix = settings.projectRoot.isEmpty ? "" : "cd \(self.shellQuote(settings.projectRoot)) && "
        let scriptBody = "\(cdPrefix)\(quotedArgs)"
        let wrapped = VoiceWakeForwarder.commandWithCliPath(scriptBody, target: settings.target)
        args.append(contentsOf: ["/bin/sh", "-c", wrapped])
        return ["/usr/bin/ssh"] + args
    }

    private struct RemoteSettings {
        let mode: AppState.ConnectionMode
        let target: String
        let identity: String
        let projectRoot: String
    }

    private static func connectionSettings() -> RemoteSettings {
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey) ?? "local"
        let mode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        let target = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        let identity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        let projectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey) ?? ""
        return RemoteSettings(mode: mode, target: self.sanitizedTarget(target), identity: identity, projectRoot: projectRoot)
    }

    private static func sanitizedTarget(_ raw: String) -> String {
        VoiceWakeForwarder.sanitizedTarget(raw)
    }

    private static func shellQuote(_ text: String) -> String {
        if text.isEmpty { return "''" }
        let escaped = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
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
