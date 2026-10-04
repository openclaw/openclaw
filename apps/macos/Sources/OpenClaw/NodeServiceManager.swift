import Foundation
import OSLog

enum NodeServiceManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "node.service")
    private static let lifecycleQueue = LifecycleQueue()
    private static var launchdPlistURL: URL {
        LaunchAgentPlist.homeDirectoryURL
            .appendingPathComponent("Library/LaunchAgents/\(nodeLaunchdLabel).plist")
    }

    static func start(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("start", profile: profile)
    }

    static func stop(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("stop", profile: profile)
    }

    static func restart(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("restart", profile: profile)
    }

    /// Empty means no node LaunchAgent. Nil means the on-disk ownership proof
    /// exists but could not be read, so callers must not treat it as external.
    static func launchdProgramArguments(profile: AppProfile = .current) -> [String]? {
        if self.skipUnderProfile(profile, action: "status") { return [] }
        return self.launchdProgramArguments(plistURL: self.launchdPlistURL)
    }

    static func installedServiceCLI(
        profile: AppProfile = .current) -> GatewayLaunchAgentManager.InstalledServiceCLI?
    {
        guard !self.skipUnderProfile(profile, action: "inspect") else { return nil }
        let directory = OpenClawPaths.stateDirURL.appendingPathComponent("service-env", isDirectory: true)
        let environmentFile = directory.appendingPathComponent("\(nodeLaunchdLabel).env")
        let wrapper = directory.appendingPathComponent("\(nodeLaunchdLabel)-env-wrapper.sh")
        guard let cli = GatewayLaunchAgentManager.captureServiceCLI(
            plist: self.launchdPlistURL,
            environmentFile: environmentFile,
            environmentWrapper: wrapper,
            subcommand: "node")
        else { return nil }
        if cli.usesGeneratedEnvironment {
            guard FileManager.default.isReadableFile(atPath: environmentFile.path),
                  FileManager.default.isReadableFile(atPath: wrapper.path)
            else { return nil }
        }
        return cli
    }

    static func waitUntilRunning(profile: AppProfile = .current) async -> Bool {
        if self.skipUnderProfile(profile, action: "status poll") { return false }
        guard let arguments = self.launchdProgramArguments(profile: profile), !arguments.isEmpty else { return false }
        var consecutiveRunningChecks = 0
        for attempt in 0..<20 {
            let result = await self.runServiceCommandResult(
                "status",
                timeout: 10,
                quiet: true)
            if result.success,
               let object = result.parsed?.object,
               self.runtimeIsRunning(in: object)
            {
                consecutiveRunningChecks += 1
                if consecutiveRunningChecks == 2 { return true }
            } else {
                consecutiveRunningChecks = 0
            }
            if attempt < 19 {
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        return false
    }
}

extension NodeServiceManager {
    private actor LifecycleQueue {
        private var tail: Task<String?, Never>?

        func run(_ action: String, profile: AppProfile) async -> String? {
            if NodeServiceManager.skipUnderProfile(profile, action: action) { return nil }
            let predecessor = self.tail
            let task = Task<String?, Never> {
                _ = await predecessor?.value
                let result = await NodeServiceManager.runServiceCommandResult(
                    action,
                    timeout: action == "stop" ? 15 : 20,
                    quiet: false)
                guard let error = NodeServiceManager.errorMessage(
                    from: result,
                    treatNotLoadedAsError: action != "stop")
                else { return nil }
                NodeServiceManager.logger.error(
                    "node service \(action, privacy: .public) failed: \(error, privacy: .public)")
                return error
            }
            self.tail = task
            return await task.value
        }
    }

    private static func skipUnderProfile(_ profile: AppProfile, action: String) -> Bool {
        guard profile.isActive else { return false }
        self.logger.info("node service \(action, privacy: .public) skipped (unavailable under app profile)")
        return true
    }

    static func serviceCommand(_ action: String) async -> [String] {
        await CommandResolver.localOpenclawCommand(
            subcommand: "node",
            extraArgs: [action, "--json"])
    }

    private struct CommandResult {
        let success: Bool
        let message: String?
        let parsed: JSONObjectExtractionSupport.ExtractedObject?
    }

    private static func runServiceCommandResult(
        _ action: String,
        timeout: Double,
        quiet: Bool) async -> CommandResult
    {
        // The bundled app worker is not a launchd service. Only a separate installed
        // service owns CLI lifecycle work; an unreadable record must still fail closed.
        guard let arguments = self.launchdProgramArguments() else {
            return CommandResult(
                success: false,
                message: "Could not read the node service ownership record. Check the node LaunchAgent and retry.",
                parsed: nil)
        }
        guard !arguments.isEmpty else {
            return CommandResult(success: true, message: nil, parsed: nil)
        }
        #if DEBUG
        self.testingServiceCommandCalls.append([action])
        #endif
        let command: [String]
        let env: [String: String]
        if BundledRuntime.isBundledApp {
            guard let cli = self.installedServiceCLI() else {
                return CommandResult(
                    success: false,
                    message: "Could not read the node service runtime. Check the node LaunchAgent and retry.",
                    parsed: nil)
            }
            command = AppProfile.current.localCLICommand(
                prefix: cli.prefix, arguments: ["node", action, "--json"])
            env = GatewayLaunchAgentManager.daemonEnvironment(
                runtime: nil,
                installedCLI: cli,
                environment: ProcessInfo.processInfo.environment,
                profile: .current,
                searchPaths: CommandResolver.preferredPaths())
        } else {
            command = await self.serviceCommand(action)
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
            env = environment
        }
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = JSONObjectExtractionSupport.extract(from: response.stdout)
            ?? JSONObjectExtractionSupport.extract(from: response.stderr)
        let ok = parsed?.object["ok"] as? Bool
        let message = (parsed?.object["error"] as? String) ?? (parsed?.object["message"] as? String)
        let success = response.success && (ok ?? true)
        if success {
            return CommandResult(success: true, message: nil, parsed: parsed)
        }

        if quiet {
            return CommandResult(success: false, message: message, parsed: parsed)
        }

        let detail = message ?? TextSummarySupport.summarizeLastLine(response.stderr)
            ?? TextSummarySupport.summarizeLastLine(response.stdout)
        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Node service command failed (\(exit)): \($0)" }
            ?? "Node service command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, message: detail, parsed: parsed)
    }

    private static func errorMessage(from result: CommandResult, treatNotLoadedAsError: Bool) -> String? {
        if !result.success {
            return result.parsed?.message ?? result.message ?? "Node service command failed"
        }
        guard let parsed = result.parsed else { return nil }
        if treatNotLoadedAsError, parsed.object["result"] as? String == "not-loaded" {
            return JSONObjectExtractionSupport.mergeHints(
                message: (parsed.object["message"] as? String) ?? "Node service not loaded.",
                hints: (parsed.object["hints"] as? [String]) ?? [])
        }
        return nil
    }

    static func launchdProgramArguments(plistURL: URL) -> [String]? {
        #if DEBUG
        self.testingOwnershipReadCount += 1
        #endif
        guard FileManager.default.fileExists(atPath: plistURL.path) else { return [] }
        guard let arguments = LaunchAgentPlist.snapshot(url: plistURL)?.programArguments,
              !arguments.isEmpty
        else { return nil }
        return arguments
    }

    private static func runtimeIsRunning(in object: [String: Any]) -> Bool {
        guard let service = object["service"] as? [String: Any],
              service["loaded"] as? Bool == true,
              let runtime = service["runtime"] as? [String: Any]
        else { return false }
        return runtime["status"] as? String == "running"
    }
}

#if DEBUG
extension NodeServiceManager {
    private nonisolated(unsafe) static var testingServiceCommandCalls: [[String]] = []
    private nonisolated(unsafe) static var testingOwnershipReadCount = 0

    static func _testResetPersistentServiceCalls() {
        self.testingServiceCommandCalls = []
        self.testingOwnershipReadCount = 0
    }

    static func _testPersistentServiceCallSnapshot() -> (commands: [[String]], ownershipReads: Int) {
        (self.testingServiceCommandCalls, self.testingOwnershipReadCount)
    }

    static func _testRuntimeIsRunning(fromJSON json: String) -> Bool {
        guard let object = JSONObjectExtractionSupport.extract(from: json)?.object else { return false }
        return self.runtimeIsRunning(in: object)
    }
}
#endif
