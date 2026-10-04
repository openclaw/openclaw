import Foundation
import Synchronization

enum GatewayLaunchAgentManager {
    struct LoadedGatewayState: Equatable, Sendable {
        let runningPID: Int32?
        let reusablePID: Int32?
    }

    struct InstalledServiceCLI: Sendable, Equatable {
        let prefix: [String]
        let sqliteLibrary: String?
        var environment: [String: String] = [:]
        var usesGeneratedEnvironment = false
        var hadRuntimePin = false
        var isInferredLegacyInstall = false
        var sourcePrefix: [String]?
        var serviceAuthority: ServiceAuthority?
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.launchd")
    private static let disableLaunchAgentMarker = "disable-launchagent"
    /// A first-run daemon command may wait behind state integrity checks and the shared startup-
    /// migration lease. Keep the app from killing healthy migration work before it can finish.
    static let startupMigrationTolerance: TimeInterval = 120

    private static var disableLaunchAgentMarkerURL: URL {
        #if DEBUG
        if let testingDisableLaunchAgentMarkerURL = self.testingState.withLock({ $0.disableLaunchAgentMarkerURL }) {
            return testingDisableLaunchAgentMarkerURL
        }
        #endif
        return self.disableLaunchAgentMarkerURL(in: OpenClawPaths.stateDirURL)
    }

    static func disableLaunchAgentMarkerURL(in stateDirectoryURL: URL) -> URL {
        stateDirectoryURL.appendingPathComponent(self.disableLaunchAgentMarker)
    }

    private static var plistURL: URL {
        self.plistURL(
            homeDirectory: LaunchAgentPlist.homeDirectoryURL,
            profile: .current)
    }

    static func plistURL(homeDirectory: URL, profile: AppProfile) -> URL {
        homeDirectory.appendingPathComponent(
            "Library/LaunchAgents/\(profile.gatewayLaunchAgentLabel).plist")
    }

    static func conflictingProfileClaimOwner(
        port: Int,
        excludingLabel: String,
        homeDirectory: URL) -> String?
    {
        let directory = homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil)
        else {
            return "installed profile Gateway claims cannot be inspected"
        }
        for url in entries {
            guard url.pathExtension == "plist" else { continue }
            let label = url.deletingPathExtension().lastPathComponent
            guard label != excludingLabel,
                  let profile = self.profile(forLaunchAgentLabel: label)
            else { continue }
            let owner = profile.name ?? "default"
            let artifacts = self.generatedEnvironmentArtifacts(
                directory: profile.stateDirectoryURL(homeDirectory: homeDirectory)
                    .appendingPathComponent("service-env", isDirectory: true),
                profile: profile)
            guard let snapshot = LaunchAgentPlist.snapshot(
                url: url,
                generatedEnvironmentFileURL: artifacts.environment,
                generatedEnvironmentWrapperURL: artifacts.wrapper),
                self.isCanonicalGatewayClaim(snapshot)
            else { continue }
            guard let claimedPort = snapshot.port else {
                return "profile \"\(owner)\" has an unreadable Gateway reservation"
            }
            if claimedPort == port { return "profile \"\(owner)\" already reserves it" }
        }
        return nil
    }

    private static func profile(forLaunchAgentLabel label: String) -> AppProfile? {
        let base = AppProfile(environment: [:])
        if label == base.gatewayLaunchAgentLabel { return base }
        let prefix = "ai.openclaw."
        guard label.hasPrefix(prefix) else { return nil }
        let name = String(label.dropFirst(prefix.count))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": name])
        return profile.name == name && profile.gatewayLaunchAgentLabel == label ? profile : nil
    }

    private static func isCanonicalGatewayClaim(_ snapshot: LaunchAgentPlistSnapshot) -> Bool {
        snapshot.environment["OPENCLAW_SERVICE_MARKER"] == "openclaw" &&
            snapshot.environment["OPENCLAW_SERVICE_KIND"] == "gateway" &&
            snapshot.programArguments.contains("gateway")
    }

    private static var generatedEnvironmentDirectoryURL: URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("service-env", isDirectory: true)
    }

    static func isLaunchAgentWriteDisabled() -> Bool {
        FileManager().fileExists(atPath: self.disableLaunchAgentMarkerURL.path)
    }

    static func applyAttachOnlyRuntimeOverride() -> String? {
        self.setLaunchAgentWriteDisabled(true)
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

    static func reusableLoadedGatewayPID(port: Int, allowUnconfigured: Bool = false) async -> Int32? {
        try? await self.loadedGatewayState(port: port, allowUnconfigured: allowUnconfigured)?.reusablePID
    }

    static func loadedGatewayState(port: Int, allowUnconfigured: Bool = false) async throws -> LoadedGatewayState? {
        guard let service = try await self.readDaemonService() else { return nil }
        let runningPID = self.runningGatewayPID(from: service)
        let runtime = service["runtime"] as? [String: Any]
        guard let loaded = service["loaded"] as? Bool,
              !loaded || runtime?["status"] as? String == "stopped" || runningPID != nil
        else {
            for state in [service["loadState"] as? [String: Any], runtime] {
                if let detail = state?["detail"] as? String,
                   !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    throw ServiceInspectionError(message: detail)
                }
            }
            return nil
        }
        let configAudit = service["configAudit"] as? [String: Any]
        let command = service["command"] as? [String: Any]
        let arguments = command?["programArguments"] as? [String] ?? []
        let reusablePID: Int32? = if self.configAuditAllowsReuse(configAudit),
                                     self.gatewayPort(from: service) == port,
                                     arguments.contains("--allow-unconfigured") == allowUnconfigured
        {
            runningPID
        } else {
            nil
        }
        return LoadedGatewayState(runningPID: runningPID, reusablePID: reusablePID)
    }

    private static func configAuditAllowsReuse(_ audit: [String: Any]?) -> Bool {
        if audit?["ok"] as? Bool == true {
            return true
        }
        guard let issues = audit?["issues"] as? [[String: Any]], !issues.isEmpty else { return false }
        // The installer may require an explicit Node bin directory. Its PATH hygiene advisory
        // must not make a healthy Gateway restart into the same advisory on every app launch.
        return issues.allSatisfy { $0["code"] as? String == "gateway-path-nonminimal" }
    }

    static func runningGatewayPID() async -> Int32? {
        guard let service = try? await self.readDaemonService() else { return nil }
        return self.runningGatewayPID(from: service)
    }

    static func set(
        enabled: Bool,
        port: Int,
        allowUnconfigured: Bool = false,
        whenMissingCLI: InstalledServiceCLI? = nil,
        expectedServiceAuthority: ServiceAuthority? = nil,
        checkCurrent: (@MainActor @Sendable () async throws -> Void)? = nil) async -> String?
    {
        if enabled, CommandResolver.connectionModeIsRemote(), !allowUnconfigured {
            self.logger.info("launchd change skipped (remote mode)")
            return nil
        }
        if self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd change skipped (disable marker set)")
            return nil
        }

        let custody: ServiceAuthority
        do { custody = try expectedServiceAuthority ?? self.gatewayServiceAuthority() } catch {
            return error.localizedDescription
        }
        if enabled {
            let label = AppProfile.current.gatewayLaunchAgentLabel
            self.logger.info("launchd enable requested via CLI for \(label) port=\(port)")
            let existing = self.launchdConfigSnapshot()
            let existed = FileManager.default.fileExists(atPath: self.plistURL.path)
            var installedCLI: InstalledServiceCLI?
            do {
                installedCLI = try self.serviceCLIForEnable(
                    snapshot: existing, serviceExists: existed, whenMissingCLI: whenMissingCLI)
            } catch { return error.localizedDescription }
            let runtime: BundledRuntime?
            do {
                runtime = BundledRuntime.isBundledApp && !existed && installedCLI == nil
                    ? try await BundledRuntime.seed() : nil
                if let runtime {
                    installedCLI = try InstalledServiceCLI(
                        prefix: runtime.cliCommand,
                        sqliteLibrary: runtime.sqliteLibrary.path,
                        environment: self
                            .retainedServiceEnvironment(stateDirectory: AppProfile.current.stateDirectoryURL()))
                }
            } catch {
                return error.localizedDescription
            }
            guard !Task.isCancelled else { return "Gateway service change was cancelled" }
            guard !self.isLaunchAgentWriteDisabled(),
                  !CommandResolver.connectionModeIsRemote() || allowUnconfigured
            else { return nil }
            if BundledRuntime.isBundledApp {
                guard FileManager.default.fileExists(atPath: self.plistURL.path) == existed,
                      self.launchdConfigSnapshot() == existing
                else { return "Gateway service changed during setup; retry" }
            }
            do { try await checkCurrent?() } catch { return error.localizedDescription }
            if let error = custody.currentError() { return error }
            var arguments = self.installArguments(
                port: port,
                allowUnconfigured: allowUnconfigured,
                runtime: runtime,
                launchAgentExists: existed)
            if !existed, let preserved = whenMissingCLI {
                guard let executable = preserved.prefix.first, executable.hasPrefix("/"),
                      ["node", "bun"].contains(URL(fileURLWithPath: executable).lastPathComponent)
                else { return "The retained Gateway runtime could not be inspected." }
                arguments += ["--runtime", URL(fileURLWithPath: executable).lastPathComponent]
                // The historical app-tools Node install remains unpinned so it can migrate later.
                if preserved.hadRuntimePin ||
                    !self.isManagedNode(executable, stateDirectory: AppProfile.current.stateDirectoryURL())
                {
                    arguments += ["--runtime-path", preserved.sourcePrefix?.first ?? executable]
                }
            }
            return await self.runDaemonCommand(
                arguments,
                runtime: runtime,
                installedCLI: installedCLI,
                expectedServiceAuthority: custody,
                checkCurrent: checkCurrent)
        }

        do { try await checkCurrent?() } catch { return error.localizedDescription }
        if let error = custody.currentError() { return error }
        guard !self.isLaunchAgentWriteDisabled() else { return "Gateway service changes are disabled" }
        let label = custody.plist.deletingPathExtension().lastPathComponent
        // Stop runs on every remote/unconfigured launch. Without this profile's plist there is
        // nothing to boot out, but the CLI would still take shared service-update locks.
        guard custody.definition.plist != nil else {
            self.logger.info("launchd disable skipped: no LaunchAgent installed for \(label)")
            return nil
        }
        self.logger.info("launchd disable requested via CLI for \(label)")
        return await self.runDaemonCommand(
            ["uninstall"], expectedServiceAuthority: custody, checkCurrent: checkCurrent)
    }

    private static func serviceCLIForEnable(
        snapshot: LaunchAgentPlistSnapshot?,
        serviceExists: Bool,
        whenMissingCLI: InstalledServiceCLI?) throws -> InstalledServiceCLI?
    {
        guard BundledRuntime.isBundledApp, serviceExists else {
            // Pause removes the plist. Resume retains the existing Node version owner.
            return try serviceExists ? nil : whenMissingCLI.map { try self.resumedServiceCLI($0) }
        }
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: self.generatedEnvironmentDirectoryURL, profile: .current)
        guard let snapshot, let cli = self.installedServiceCLI(
            snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper)
        else {
            throw GatewayHostingError(
                message: "Gateway service CLI could not be inspected; repair the existing service first")
        }
        if cli.usesGeneratedEnvironment {
            guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
                  FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
            else {
                throw GatewayHostingError(
                    message: "Gateway service environment could not be read; repair the existing service first")
            }
        }
        return cli
    }

    static func installArguments(
        port: Int,
        allowUnconfigured: Bool,
        runtime: BundledRuntime?,
        launchAgentExists: Bool,
        replaceRuntime: Bool = false) -> [String]
    {
        var arguments = ["install", "--force", "--port", "\(port)"]
        if allowUnconfigured { arguments.append("--allow-unconfigured") }
        // Existing services retain core's saved runtime intent unless the app update or migration owns replacement.
        if let runtime, !launchAgentExists || replaceRuntime {
            arguments += ["--runtime", "bun", "--runtime-path", runtime.bun.path]
        }
        return arguments
    }

    static func bundledRuntimeReplacementError(
        appManaged: Bool,
        installedRuntimePath: String?,
        stateDirectory: URL) -> String?
    {
        guard appManaged else { return "Gateway service is not managed by OpenClaw.app" }
        guard let installedRuntimePath else { return "Gateway service runtime could not be inspected" }
        let directory = stateDirectory.appendingPathComponent("runtime", isDirectory: true)
        let pin = URL(fileURLWithPath: installedRuntimePath)
        // Status does not expose pin metadata. Conservatively preserve every external executable,
        // including unpinned ones, instead of inferring absent runtime intent from omitted JSON.
        // Match directory boundaries before and after symlink resolution: a sibling directory or
        // an app-looking link to an operator runtime does not confer ownership of that runtime.
        guard installedRuntimePath.hasPrefix("/"),
              pin.standardizedFileURL.path.hasPrefix(directory.standardizedFileURL.path + "/"),
              pin.resolvingSymlinksInPath().path.hasPrefix(directory.resolvingSymlinksInPath().path + "/")
        else { return "Gateway service uses an operator-pinned runtime; update it yourself" }
        return nil
    }

    static func retainedServiceEnvironment(
        stateDirectory: URL,
        profile: AppProfile = .current) throws -> [String: String]
    {
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: stateDirectory.appendingPathComponent("service-env"), profile: profile)
        func exists(_ url: URL) throws -> Bool {
            do {
                _ = try FileManager.default.attributesOfItem(atPath: url.path)
                return true
            } catch let error as NSError where error.domain == NSCocoaErrorDomain &&
                (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError)
            {
                return false
            }
        }
        guard try exists(artifacts.environment) || exists(artifacts.wrapper) else { return [:] }
        guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
              FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
        else {
            throw GatewayHostingError(message: "The retained Gateway environment is unavailable; repair its service.")
        }
        return try LaunchAgentPlist.parseGeneratedEnvironment(
            String(contentsOf: artifacts.environment, encoding: .utf8))
    }

    static func reinstallBundledRuntime(
        runtime: BundledRuntime,
        port: Int,
        allowUnconfigured: Bool = false,
        environment: [String: String]? = nil,
        expectedServiceAuthority: ServiceAuthority? = nil,
        checkCurrent: (@MainActor @Sendable () async throws -> Void)? = nil) async -> String?
    {
        guard !self.isLaunchAgentWriteDisabled() else { return "Gateway service changes are disabled" }
        let custody: ServiceAuthority
        do { custody = try expectedServiceAuthority ?? self.gatewayServiceAuthority() } catch {
            return error.localizedDescription
        }
        let snapshot = self.launchdConfigSnapshot()
        let exists = FileManager.default.fileExists(atPath: self.plistURL.path)
        if let snapshot {
            let artifacts = self.generatedEnvironmentArtifacts(
                directory: self.generatedEnvironmentDirectoryURL, profile: .current)
            let command = self.installedGatewayCommand(
                programArguments: snapshot.programArguments,
                environmentFile: artifacts.environment,
                environmentWrapper: artifacts.wrapper)
            let appManaged: Bool = if let command, command.contains("gateway") {
                await CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: command)
            } else {
                false
            }
            if let error = self.bundledRuntimeReplacementError(
                appManaged: appManaged,
                installedRuntimePath: command?.first,
                stateDirectory: AppProfile.current.stateDirectoryURL())
            {
                return error
            }
        } else {
            guard !exists else { return "Gateway service ownership could not be inspected" }
            do {
                // A missing plist is not proof that launchd has no loaded, externally managed job.
                guard let service = try await self.readDaemonService(), service["loaded"] as? Bool == false,
                      (service["command"] as? [String: Any]) == nil
                else { return "Gateway service ownership could not be inspected" }
            } catch {
                return error.localizedDescription
            }
        }
        do { try await checkCurrent?() } catch { return error.localizedDescription }
        guard !Task.isCancelled else { return "Gateway service update was cancelled" }
        if let error = custody.currentError() { return error }
        guard !self.isLaunchAgentWriteDisabled(),
              FileManager.default.fileExists(atPath: self.plistURL.path) == exists,
              self.launchdConfigSnapshot() == snapshot
        else { return "Gateway service changed during update; retry the app update" }
        return await self.runDaemonCommand(
            self.installArguments(
                port: port,
                allowUnconfigured: allowUnconfigured,
                runtime: runtime,
                launchAgentExists: exists,
                replaceRuntime: true),
            runtime: runtime,
            installedCLI: environment.map {
                InstalledServiceCLI(
                    prefix: runtime.cliCommand,
                    sqliteLibrary: runtime.sqliteLibrary.path,
                    environment: $0)
            },
            expectedServiceAuthority: custody,
            checkCurrent: checkCurrent)
    }

    static func installedGatewayCommand(
        programArguments: [String],
        environmentFile: URL,
        environmentWrapper: URL) -> [String]?
    {
        var command = programArguments[...]
        if command.first == "/bin/sh" { command = command.dropFirst() }
        if command.first == environmentWrapper.path {
            command = command.dropFirst()
            guard command.first == environmentFile.path else { return nil }
            command = command.dropFirst()
        } else if programArguments.first == "/bin/sh" {
            return nil
        }
        guard let executable = command.first, executable.hasPrefix("/") else { return nil }
        return Array(command)
    }

    static func installedServiceCLI() -> InstalledServiceCLI? {
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: self.generatedEnvironmentDirectoryURL, profile: .current)
        return self.captureServiceCLI(
            plist: self.plistURL,
            environmentFile: artifacts.environment,
            environmentWrapper: artifacts.wrapper)
    }

    static func installedServiceCLI(
        snapshot: LaunchAgentPlistSnapshot,
        environmentFile: URL,
        environmentWrapper: URL,
        subcommand: String = "gateway") -> InstalledServiceCLI?
    {
        guard let command = self.installedGatewayCommand(
            programArguments: snapshot.programArguments,
            environmentFile: environmentFile,
            environmentWrapper: environmentWrapper),
            let service = command.firstIndex(of: subcommand), service >= 2,
            let executable = command.first,
            ["node", "bun"].contains(URL(fileURLWithPath: executable).lastPathComponent)
        else { return nil }
        let prefix = Array(command[..<service])
        let entry = prefix.dropFirst().drop(while: {
            $0.hasPrefix("--max-old-space-size=") ||
                $0.hasPrefix("--max-old-space-size-percentage=") || $0.hasPrefix("--max-heap-size=")
        })
        guard entry.count == 1, let script = entry.first, script.hasPrefix("/") else { return nil }
        let url = URL(fileURLWithPath: script)
        guard url.lastPathComponent == "openclaw.mjs" ||
            (url.deletingLastPathComponent().lastPathComponent == "dist" &&
                ["index.js", "index.mjs", "entry.js", "entry.mjs"].contains(url.lastPathComponent))
        else { return nil }
        return InstalledServiceCLI(
            prefix: self.concreteServicePrefix(prefix),
            sqliteLibrary: snapshot.environment["OPENCLAW_SQLITE_LIBRARY"],
            environment: snapshot.environment,
            usesGeneratedEnvironment: snapshot.programArguments.first == "/bin/sh" ||
                snapshot.programArguments.first == environmentWrapper.path,
            sourcePrefix: prefix)
    }

    static func kickstart() async -> String? {
        if self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd restart skipped (disable marker set)")
            return nil
        }
        return await self.runDaemonCommand(["restart"])
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        let directory = self.generatedEnvironmentDirectoryURL
        let artifacts = self.generatedEnvironmentArtifacts(directory: directory, profile: .current)
        return LaunchAgentPlist.snapshot(
            url: self.plistURL,
            generatedEnvironmentFileURL: artifacts.environment,
            generatedEnvironmentWrapperURL: artifacts.wrapper)
    }

    static func generatedEnvironmentArtifacts(
        directory: URL,
        profile: AppProfile) -> (environment: URL, wrapper: URL)
    {
        (
            directory.appendingPathComponent("\(profile.gatewayLaunchAgentLabel).env"),
            directory.appendingPathComponent("\(profile.gatewayLaunchAgentLabel)-env-wrapper.sh"))
    }

    /// Empty means no Gateway LaunchAgent. Nil preserves an unreadable
    /// ownership record so update callers fail closed instead of consuming it.
    static func launchdProgramArguments() -> [String]? {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return [] }
        guard let arguments = self.launchdConfigSnapshot()?.programArguments, !arguments.isEmpty else { return nil }
        return arguments
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
}

extension GatewayLaunchAgentManager {
    private struct ServiceInspectionError: LocalizedError, Sendable {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }

    static func serviceIsConfirmedAbsent(installedCLI: InstalledServiceCLI?) async throws -> Bool {
        guard let service = try await self.readDaemonService(installedCLI: installedCLI) else { return false }
        return service["loaded"] as? Bool == false && (service["command"] == nil || service["command"] is NSNull)
    }

    private static func readDaemonService(installedCLI: InstalledServiceCLI? = nil) async throws -> [String: Any]? {
        let result = await self.runDaemonCommandResult(
            ["status", "--json", "--no-probe"],
            timeout: 15,
            quiet: true,
            installedCLI: installedCLI)
        guard result.success else {
            throw ServiceInspectionError(message: result.message ?? "Gateway service inspection failed")
        }
        guard let payload = result.payload else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
            let service = json["service"] as? [String: Any]
        else {
            return nil
        }
        return service
    }

    private static func gatewayPort(from service: [String: Any]) -> Int? {
        guard let command = service["command"] as? [String: Any] else { return nil }
        if let arguments = command["programArguments"] as? [String] {
            for (index, argument) in arguments.enumerated() {
                if argument == "--port" {
                    guard arguments.indices.contains(index + 1) else { return nil }
                    return self.validGatewayPort(arguments[index + 1])
                }
                if argument.hasPrefix("--port=") {
                    return self.validGatewayPort(String(argument.dropFirst("--port=".count)))
                }
            }
        }
        let environment = command["environment"] as? [String: Any]
        return self.validGatewayPort(environment?["OPENCLAW_GATEWAY_PORT"] as? String)
    }

    private static func validGatewayPort(_ raw: String?) -> Int? {
        guard let raw,
              let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(port)
        else {
            return nil
        }
        return port
    }

    private static func runningGatewayPID(from service: [String: Any]) -> Int32? {
        guard service["loaded"] as? Bool == true,
              let runtime = service["runtime"] as? [String: Any],
              runtime["status"] as? String == "running",
              let pid = runtime["pid"] as? Int,
              pid > 0,
              pid <= Int(Int32.max)
        else {
            return nil
        }
        return Int32(pid)
    }

    private struct CommandResult {
        let success: Bool
        let payload: Data?
        let message: String?
    }

    static let runtimePinSelectionChanged = "Gateway service or runtime pin changed before installation. " +
        "The newer selection was preserved; inspect it before retrying."

    private struct DaemonInvocation {
        let prefix: [String]
        let environment: [String: String]
        let supportsExpectedRuntimePin: Bool
    }

    static func runDaemonCommand(
        _ args: [String],
        timeout: Double = Self.startupMigrationTolerance,
        quiet: Bool = false,
        runtime: BundledRuntime? = nil,
        installedCLI: InstalledServiceCLI? = nil,
        legacyAuthority: InstalledServiceCLI? = nil,
        expectedServiceAuthority: ServiceAuthority? = nil,
        checkCurrent: (@MainActor @Sendable () async throws -> Void)? = nil) async -> String?
    {
        let result = await self.runDaemonCommandResult(
            args,
            timeout: timeout,
            quiet: quiet,
            runtime: runtime,
            installedCLI: installedCLI,
            legacyAuthority: legacyAuthority,
            expectedServiceAuthority: expectedServiceAuthority,
            checkCurrent: checkCurrent)
        if result.success { return nil }
        return result.message ?? "Gateway daemon command failed"
    }

    private static func runDaemonCommandResult(
        _ args: [String],
        timeout: Double,
        quiet: Bool,
        runtime: BundledRuntime? = nil,
        installedCLI: InstalledServiceCLI? = nil,
        legacyAuthority: InstalledServiceCLI? = nil,
        expectedServiceAuthority: ServiceAuthority? = nil,
        checkCurrent: (@MainActor @Sendable () async throws -> Void)? = nil) async -> CommandResult
    {
        let beforeSpawn: (@Sendable () -> String?)?
        if args.first.map(["install", "uninstall", "restart"].contains) == true {
            let custody: ServiceAuthority
            do { custody = try expectedServiceAuthority ?? self.gatewayServiceAuthority() } catch {
                return CommandResult(success: false, payload: nil, message: error.localizedDescription)
            }
            let authority = legacyAuthority ?? installedCLI
            beforeSpawn = {
                guard !self.isLaunchAgentWriteDisabled() else { return "Gateway service changes are disabled" }
                if let error = custody.currentError() { return error }
                if let installedCLI, let error = self.serviceCommandPathError(for: installedCLI) { return error }
                guard let authority else { return nil }
                return self.serviceCommandPathError(for: authority) ?? self.legacyServiceAuthorityError(for: authority)
            }
        } else {
            beforeSpawn = nil
        }
        let invocation = await self.daemonInvocation(runtime: runtime, installedCLI: installedCLI)
        var arguments = args
        if args.first == "install", invocation.supportsExpectedRuntimePin {
            let observation = await self.executeDaemonCommand(
                ["status", "--deep", "--json", "--no-probe"],
                invocation: invocation,
                timeout: timeout,
                quiet: true)
            guard observation.success, let payload = observation.payload,
                  let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let service = json["service"] as? [String: Any],
                  let intent = service["runtimeIntent"] as? [String: Any],
                  intent["status"] as? String == "known",
                  let revision = intent["revision"] as? String,
                  intent["definition"] == nil || intent["definition"] is NSNull || intent["definition"] is String,
                  let expected = try? JSONSerialization.data(withJSONObject: [
                      "revision": revision,
                      "definition": intent["definition"] ?? NSNull(),
                  ], options: [.sortedKeys, .withoutEscapingSlashes]),
                  let expectation = String(bytes: expected, encoding: .utf8)
            else { return CommandResult(success: false, payload: nil, message: self.runtimePinSelectionChanged) }
            arguments += ["--expected-runtime-pin", expectation]
        }
        return await self.executeDaemonCommand(
            arguments,
            invocation: invocation,
            timeout: timeout,
            quiet: quiet,
            beforeSpawn: beforeSpawn,
            checkCurrent: checkCurrent)
    }

    private static func executeDaemonCommand(
        _ args: [String],
        invocation: DaemonInvocation,
        timeout: Double,
        quiet: Bool,
        beforeSpawn: (@Sendable () -> String?)? = nil,
        checkCurrent: (@MainActor @Sendable () async throws -> Void)? = nil) async -> CommandResult
    {
        let command = invocation.prefix + self.withJsonFlag(args)
        #if DEBUG
        if self.testingState.withLock({ $0.resolveCLI != nil }) {
            do { try await checkCurrent?() } catch {
                return CommandResult(success: false, payload: nil, message: error.localizedDescription)
            }
            if let error = beforeSpawn?() { return CommandResult(success: false, payload: nil, message: error) }
            // Snapshot each response and remove it from the queue before a hook can suspend
            // or reenter. Commands run off-actor while tests read their call snapshots.
            let (hook, payload) = self.testingState.withLock { state in
                state.commandCalls.append((arguments: args, command: command))
                let payload = if args.first == "status", !state.statusPayloads.isEmpty {
                    state.statusPayloads.removeFirst()
                } else {
                    state.statusPayload ?? "{\"ok\":true}"
                }
                return (state.commandHook, payload)
            }
            await hook?(args)
            let parsed = JSONObjectExtractionSupport.extract(from: payload)
            return CommandResult(
                success: (parsed?.object["ok"] as? Bool) ?? true,
                payload: Data(payload.utf8),
                message: parsed?.message)
        }
        if ProcessInfo.processInfo.isRunningTests {
            return CommandResult(
                success: false,
                payload: nil,
                message: "Gateway daemon commands require explicit interception during tests")
        }
        #endif
        do { try await checkCurrent?() } catch {
            return CommandResult(success: false, payload: nil, message: error.localizedDescription)
        }
        let response = await ShellExecutor.runDetailed(
            command: command, cwd: nil, env: invocation.environment, timeout: timeout, beforeSpawn: beforeSpawn)
        if let error = response.preflightError { return CommandResult(success: false, payload: nil, message: error) }
        let parsed = JSONObjectExtractionSupport.extract(from: response.stdout)
            ?? JSONObjectExtractionSupport.extract(from: response.stderr)
        let ok = parsed?.object["ok"] as? Bool
        let message = parsed?.message
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = response.success && (ok ?? true)
        if success {
            return CommandResult(success: true, payload: payload, message: nil)
        }

        let detail = message ?? TextSummarySupport.summarizeLastLine(response.stderr)
            ?? TextSummarySupport.summarizeLastLine(response.stdout)
        if quiet {
            return CommandResult(success: false, payload: payload, message: detail)
        }

        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Gateway daemon command failed (\(exit)): \($0)" }
            ?? "Gateway daemon command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, payload: payload, message: detail)
    }

    private static func daemonInvocation(
        runtime: BundledRuntime? = nil,
        installedCLI: InstalledServiceCLI? = nil) async -> DaemonInvocation
    {
        let runtime = runtime ??
            (BundledRuntime.isBundledApp && installedCLI == nil ? try? BundledRuntime.seeded() : nil)
        var resolveCLI: CommandResolver.LocalCLIResolver = CommandResolver.resolveLocalCLI
        #if DEBUG
        resolveCLI = self.testingState.withLock { $0.resolveCLI } ?? resolveCLI
        #endif
        let prefix: [String] = if let cli = installedCLI?.prefix ?? runtime?.cliCommand {
            AppProfile.current.localCLICommand(prefix: cli, arguments: ["gateway"])
        } else {
            await CommandResolver.localOpenclawCommand(subcommand: "gateway", resolveCLI: resolveCLI)
        }
        return DaemonInvocation(
            prefix: prefix,
            environment: self.daemonEnvironment(
                runtime: runtime,
                installedCLI: installedCLI,
                environment: ProcessInfo.processInfo.environment,
                profile: .current,
                searchPaths: CommandResolver.preferredPaths()),
            // Only an explicitly selected bundled CLI carries this interop contract.
            supportsExpectedRuntimePin: runtime != nil &&
                (installedCLI == nil || installedCLI?.prefix == runtime?.cliCommand))
    }

    static func daemonEnvironment(
        runtime: BundledRuntime?,
        installedCLI: InstalledServiceCLI? = nil,
        environment: [String: String],
        profile: AppProfile,
        searchPaths: [String]) -> [String: String]
    {
        var result = environment.merging(installedCLI?.environment ?? [:]) { _, installed in installed }
        let installedPaths = installedCLI?.environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        var paths = installedPaths + searchPaths
        if let runtime {
            paths.insert(runtime.bun.deletingLastPathComponent().path, at: 0)
            result["OPENCLAW_SQLITE_LIBRARY"] = runtime.sqliteLibrary.path
        }
        if let installedCLI {
            if let executable = installedCLI.prefix.first {
                paths.insert(URL(fileURLWithPath: executable).deletingLastPathComponent().path, at: 0)
            }
            result["OPENCLAW_SQLITE_LIBRARY"] = installedCLI.sqliteLibrary
        }
        var seen = Set<String>()
        result["PATH"] = paths.filter { seen.insert($0).inserted }.joined(separator: ":")
        result["OPENCLAW_PROFILE"] = profile.name ?? "default"
        if profile.isActive || runtime != nil || installedCLI != nil {
            let directory = profile.stateDirectoryURL()
            result["OPENCLAW_STATE_DIR"] = directory.path
            result["OPENCLAW_CONFIG_PATH"] = directory.appendingPathComponent("openclaw.json").path
        }
        return GatewayChildSupervisor.environmentWithoutSupervisorMarkers(result)
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    #if DEBUG
    private struct TestingState: Sendable {
        var disableLaunchAgentMarkerURL: URL?
        var resolveCLI: CommandResolver.LocalCLIResolver?
        var commandCalls: [(arguments: [String], command: [String])] = []
        var statusPayload: String?
        var statusPayloads: [String] = []
        var commandHook: (@Sendable ([String]) async -> Void)?
    }

    private static let testingState = Mutex(TestingState())

    static func setTestingDisableLaunchAgentMarkerURL(_ url: URL?) {
        self.testingState.withLock { $0.disableLaunchAgentMarkerURL = url }
    }

    static func setTestingInterceptDaemonCommands(
        _ intercept: Bool,
        beforeReturning hook: (@Sendable ([String]) async -> Void)? = nil,
        resolveCLI: @escaping CommandResolver.LocalCLIResolver = { _, _ in .executable(["openclaw"]) })
    {
        self.testingState.withLock {
            $0.resolveCLI = intercept ? resolveCLI : nil
            $0.commandHook = hook
        }
    }

    static func setTestingDaemonStatusPayload(_ payload: String?) {
        self.testingState.withLock {
            $0.statusPayload = payload
            $0.statusPayloads = []
        }
    }

    static func setTestingDaemonStatusPayloads(_ payloads: [String]) {
        self.testingState.withLock {
            $0.statusPayload = nil
            $0.statusPayloads = payloads
        }
    }

    static func clearTestingDaemonCommandCalls() {
        self.testingState.withLock { $0.commandCalls.removeAll(keepingCapacity: false) }
    }

    static func testingDaemonCommandCallsSnapshot() -> [[String]] {
        self.testingState.withLock { $0.commandCalls.map(\.arguments) }
    }

    static func testingResolvedDaemonCommandsSnapshot() -> [[String]] {
        self.testingState.withLock { $0.commandCalls.map(\.command) }
    }

    static func _testRunningGatewayPID(from json: String) -> Int32? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let service = object["service"] as? [String: Any]
        else {
            return nil
        }
        return self.runningGatewayPID(from: service)
    }

    static func _testLaunchdProgramArguments(plistURL: URL) -> [String]? {
        guard FileManager.default.fileExists(atPath: plistURL.path) else { return [] }
        return LaunchAgentPlist.snapshot(url: plistURL)?.programArguments
    }
    #endif
}
