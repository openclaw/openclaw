import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.launchd")
    private static let disableLaunchAgentMarker = ".openclaw/disable-launchagent"

    private static var disableLaunchAgentMarkerURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(self.disableLaunchAgentMarker)
    }

    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
    }

    static func isLaunchAgentWriteDisabled() -> Bool {
        if FileManager().fileExists(atPath: self.disableLaunchAgentMarkerURL.path) { return true }
        return false
    }

    static func setLaunchAgentWriteDisabled(_ disabled: Bool) -> String? {
        let marker = self.disableLaunchAgentMarkerURL
        if disabled {
            do {
                try FileManager().createDirectory(
                    at: marker.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                if !FileManager().fileExists(atPath: marker.path) {
                    FileManager().createFile(atPath: marker.path, contents: nil)
                }
            } catch {
                return error.localizedDescription
            }
            return nil
        }

        if FileManager().fileExists(atPath: marker.path) {
            do {
                try FileManager().removeItem(at: marker)
            } catch {
                return error.localizedDescription
            }
        }
        return nil
    }

    static func isLoaded() async -> Bool {
        guard let loaded = await self.readDaemonLoaded() else { return false }
        return loaded
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
        guard !CommandResolver.connectionModeIsRemote() else {
            self.logger.info("launchd change skipped (remote mode)")
            return nil
        }
        if enabled, self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd enable skipped (disable marker set)")
            return nil
        }

        if enabled {
            self.logger.info("launchd enable requested via CLI port=\(port)")
            let loaded = await self.readDaemonLoaded() == true
            let snapshot = self.launchdConfigSnapshot()
            let plan = self.enableCommandPlan(
                isAlreadyLoaded: loaded,
                snapshot: snapshot,
                desiredPort: port,
                desiredRuntime: "node")
            if plan.isEmpty {
                self.logger.info("launchd already loaded; skipping enable")
                return nil
            }

            // Prefer start over reinstall so we avoid rewriting launchd/config state
            // on every app launch.
            for (index, command) in plan.enumerated() {
                let isLast = index == plan.count - 1
                if isLast {
                    return await self.runDaemonCommand(command, timeout: 20)
                }
                let result = await self.runDaemonCommandResult(command, timeout: 20, quiet: true)
                if self.isTerminalEnableSuccess(
                    command: command,
                    success: result.success,
                    daemonResult: result.result)
                {
                    return nil
                }
                if self.isNonTerminalSuccessfulStep(
                    command: command,
                    success: result.success,
                    daemonResult: result.result)
                {
                    let step = command.joined(separator: " ")
                    let daemonResult = result.result ?? "ok"
                    self.logger.info(
                        "launchd step completed but requires follow-up (\(step, privacy: .public); result=\(daemonResult, privacy: .public))")
                    continue
                }
                let message = result.message ?? "unknown error"
                if index == 0 {
                    self.logger.warning(
                        "launchd start failed (\(message, privacy: .public)); attempting install")
                } else {
                    self.logger.warning(
                        "launchd install failed (\(message, privacy: .public)); attempting forced install")
                }
            }
            return nil
        }

        self.logger.info("launchd disable requested via CLI")
        return await self.runDaemonCommand(["uninstall"])
    }

    static func kickstart() async {
        _ = await self.runDaemonCommand(["restart"], timeout: 20)
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        LaunchAgentPlist.snapshot(url: self.plistURL)
    }

    static func launchdGatewayLogPath() -> String {
        let snapshot = self.launchdConfigSnapshot()
        if let stdout = snapshot?.stdoutPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stdout.isEmpty
        {
            return stdout
        }
        if let stderr = snapshot?.stderrPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stderr.isEmpty
        {
            return stderr
        }
        return LogLocator.launchdGatewayLogPath
    }

    static func enableCommandPlan(
        isAlreadyLoaded: Bool,
        snapshot: LaunchAgentPlistSnapshot? = nil,
        desiredPort: Int,
        desiredRuntime: String = "node") -> [[String]]
    {
        if isAlreadyLoaded {
            if self.loadedServiceMatchesDesiredConfig(
                snapshot: snapshot,
                desiredPort: desiredPort,
                desiredRuntime: desiredRuntime)
            {
                return []
            }
            // Service is loaded but stale (or unknown). Reinstall without restart-first so args are reapplied.
            return [
                ["install", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
                ["install", "--force", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
            ]
        }

        // Service not loaded, but plist exists with stale args. Reinstall first so
        // launchd starts with desired port/runtime instead of resurrecting old config.
        if snapshot != nil,
           !self.loadedServiceMatchesDesiredConfig(
               snapshot: snapshot,
               desiredPort: desiredPort,
               desiredRuntime: desiredRuntime)
        {
            return [
                ["install", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
                ["install", "--force", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
            ]
        }

        return [
            ["start"],
            ["install", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
            ["install", "--force", "--port", "\(desiredPort)", "--runtime", desiredRuntime],
        ]
    }

    private static func loadedServiceMatchesDesiredConfig(
        snapshot: LaunchAgentPlistSnapshot?,
        desiredPort: Int,
        desiredRuntime: String) -> Bool
    {
        guard let snapshot else { return false }
        guard snapshot.port == desiredPort else { return false }
        guard let runtime = self.runtimeName(from: snapshot.programArguments) else { return false }
        return runtime == desiredRuntime
    }

    private static func runtimeName(from programArguments: [String]) -> String? {
        guard let executable = programArguments.first?.trimmingCharacters(in: .whitespacesAndNewlines),
              !executable.isEmpty
        else {
            return nil
        }
        let base = URL(fileURLWithPath: executable).lastPathComponent.lowercased()
        if base == "node" || base == "node.exe" { return "node" }
        if base == "bun" || base == "bun.exe" { return "bun" }
        return nil
    }

    static func isTerminalEnableSuccess(
        command: [String],
        success: Bool,
        daemonResult: String?) -> Bool
    {
        guard success else { return false }
        guard let action = command.first else { return success }
        let normalizedResult = daemonResult?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch action {
        case "start":
            // start: result "not-loaded" means install is still required.
            return normalizedResult != "not-loaded"
        case "install":
            // install (non-force): result "already-installed" means args were not reapplied.
            // Continue to force-install fallback for stale loaded services.
            if command.contains("--force") {
                return true
            }
            return normalizedResult != "already-installed"
        default:
            return success
        }
    }

    static func isNonTerminalSuccessfulStep(
        command: [String],
        success: Bool,
        daemonResult: String?) -> Bool
    {
        success && !self.isTerminalEnableSuccess(
            command: command,
            success: success,
            daemonResult: daemonResult)
    }
}

extension GatewayLaunchAgentManager {
    private static func readDaemonLoaded() async -> Bool? {
        let result = await self.runDaemonCommandResult(
            ["status", "--json", "--no-probe"],
            timeout: 15,
            quiet: true)
        guard result.success, let payload = result.payload else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
            let service = json["service"] as? [String: Any],
            let loaded = service["loaded"] as? Bool
        else {
            return nil
        }
        return loaded
    }

    private struct CommandResult {
        let success: Bool
        let payload: Data?
        let message: String?
        let result: String?
    }

    private struct ParsedDaemonJson {
        let text: String
        let object: [String: Any]
    }

    private static func runDaemonCommand(
        _ args: [String],
        timeout: Double = 15,
        quiet: Bool = false) async -> String?
    {
        let result = await self.runDaemonCommandResult(args, timeout: timeout, quiet: quiet)
        if result.success { return nil }
        return result.message ?? "Gateway daemon command failed"
    }

    private static func runDaemonCommandResult(
        _ args: [String],
        timeout: Double,
        quiet: Bool) async -> CommandResult
    {
        let command = CommandResolver.openclawCommand(
            subcommand: "gateway",
            extraArgs: self.withJsonFlag(args),
            // Launchd management must always run locally, even if remote mode is configured.
            configRoot: ["gateway": ["mode": "local"]])
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = self.parseDaemonJson(from: response.stdout) ?? self.parseDaemonJson(from: response.stderr)
        let ok = parsed?.object["ok"] as? Bool
        let message = (parsed?.object["error"] as? String) ?? (parsed?.object["message"] as? String)
        let result = parsed?.object["result"] as? String
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = ok ?? response.success
        if success {
            return CommandResult(success: true, payload: payload, message: nil, result: result)
        }

        if quiet {
            return CommandResult(success: false, payload: payload, message: message, result: result)
        }

        let detail = message ?? self.summarize(response.stderr) ?? self.summarize(response.stdout)
        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Gateway daemon command failed (\(exit)): \($0)" }
            ?? "Gateway daemon command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, payload: payload, message: detail, result: result)
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    private static func parseDaemonJson(from raw: String) -> ParsedDaemonJson? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.firstIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}")
        else {
            return nil
        }
        let jsonText = String(trimmed[start...end])
        guard let data = jsonText.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ParsedDaemonJson(text: jsonText, object: object)
    }

    private static func summarize(_ text: String) -> String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let last = lines.last else { return nil }
        let normalized = last.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return normalized.count > 200 ? String(normalized.prefix(199)) + "…" : normalized
    }
}
