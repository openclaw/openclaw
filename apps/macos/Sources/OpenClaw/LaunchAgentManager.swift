import Foundation
import OSLog

@MainActor
final class LaunchAgentManager {
    static let shared = LaunchAgentManager()

    private nonisolated static let logger = Logger(subsystem: "ai.openclaw", category: "app.login-agent")
    private nonisolated static var defaultPlistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.mac.plist")
    }

    private let plistURL: URL
    private let runLaunchctl: @Sendable ([String]) async -> Int32
    private var generation: UInt64 = 0
    private var mutationTail: Task<Bool, Never>?

    init(
        plistURL: URL = LaunchAgentManager.defaultPlistURL,
        runLaunchctl: @escaping @Sendable ([String]) async -> Int32 = LaunchAgentManager.executeLaunchctl)
    {
        self.plistURL = plistURL
        self.runLaunchctl = runLaunchctl
    }

    @discardableResult
    func loadStatus(
        profile: AppProfile = .current,
        onStatus: @escaping @MainActor (Bool) -> Void) -> Task<Void, Never>
    {
        let generation = self.generation
        let plistURL = self.plistURL
        let runLaunchctl = self.runLaunchctl
        let pendingMutation = self.mutationTail
        return Task { [weak self] in
            await pendingMutation?.value
            let loaded = await Self.readStatus(plistURL: plistURL, profile: profile, runLaunchctl: runLaunchctl)
            guard let self, self.generation == generation else { return }
            onStatus(loaded)
        }
    }

    @discardableResult
    func set(
        enabled: Bool,
        bundlePath: String,
        profile: AppProfile = .current,
        onResult: (@MainActor (Bool?, String?) -> Void)? = nil) -> Task<Bool, Never>
    {
        // Reserve user-event order before creating async work; startup hydration
        // cannot overwrite a choice while its launchctl operation is pending.
        self.generation &+= 1
        let generation = self.generation
        let previous = self.mutationTail
        let task = Task {
            await previous?.value
            let result = await self.apply(
                enabled: enabled,
                bundlePath: bundlePath,
                profile: profile,
                generation: generation)
            guard self.generation == generation, let result else { return false }
            onResult?(result.enabled, result.error)
            return result.error == nil
        }
        self.mutationTail = task
        return task
    }

    @discardableResult
    func restart(profile: AppProfile = .current) -> Task<Bool, Never> {
        let previous = self.mutationTail
        let runLaunchctl = self.runLaunchctl
        let task = Task {
            await previous?.value
            guard !profile.isActive else {
                Self.logger.info("login-agent restart skipped (unavailable under app profile)")
                return false
            }
            return await runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"]) == 0
        }
        self.mutationTail = task
        return task
    }

    @concurrent
    private static func readStatus(
        plistURL: URL,
        profile: AppProfile,
        runLaunchctl: @Sendable ([String]) async -> Int32) async -> Bool
    {
        guard !profile.isActive else {
            self.logger.info("login-agent status skipped (unavailable under app profile)")
            return false
        }
        guard FileManager.default.fileExists(atPath: plistURL.path) else { return false }
        return await runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"]) == 0
    }

    private func apply(
        enabled: Bool,
        bundlePath: String,
        profile: AppProfile,
        generation: UInt64) async -> (enabled: Bool?, error: String?)?
    {
        guard self.generation == generation else { return nil }
        guard !profile.isActive else {
            Self.logger.info("login-agent change skipped (unavailable under app profile)")
            return (false, String(localized: "Launch at Login is unavailable under a named profile."))
        }
        let previousPlist: Data?
        do {
            previousPlist = enabled && FileManager.default.fileExists(atPath: self.plistURL.path)
                ? try Data(contentsOf: self.plistURL) : nil
            try await Self.persist(enabled: enabled, bundlePath: bundlePath, plistURL: self.plistURL)
        } catch {
            Self.logger.error("login-agent persistence failed: \(error.localizedDescription, privacy: .public)")
            // Persistence must succeed before any launchctl operation, including a status probe.
            // Leave reconciliation with the caller's previous value when no state was observed.
            return (nil, String(localized:
                "Could not save Launch at Login. Check permissions for ~/Library/LaunchAgents and try again."))
        }
        guard self.generation == generation else { return nil }
        guard enabled else { return (false, nil) }
        let target = "gui/\(getuid())/\(launchdLabel)"
        let status = await self.runLaunchctl(["print", target])
        guard self.generation == generation else { return nil }
        // Reinstalling a loaded login job would boot out the app that must bootstrap it again.
        if status == 0 { return (true, nil) }
        // launchctl reports a missing service with ESRCH or its service-not-found code.
        guard status == 3 || status == 113 else {
            return await self.failedChange(command: "print", status: status, previousPlist: previousPlist)
        }
        // An absent job needs no bootout; never unload the app that owns this request.
        for arguments in [
            ["bootstrap", "gui/\(getuid())", self.plistURL.path],
            ["kickstart", "-k", target],
        ] {
            guard self.generation == generation else { return nil }
            let status = await self.runLaunchctl(arguments)
            guard self.generation == generation else { return nil }
            guard status == 0 else {
                return await self.failedChange(
                    command: arguments[0], status: status, previousPlist: previousPlist)
            }
        }
        let finalStatus = await self.runLaunchctl(["print", target])
        guard self.generation == generation else { return nil }
        guard finalStatus == 0 else {
            return await self.failedChange(command: "print", status: finalStatus, previousPlist: previousPlist)
        }
        return (true, nil)
    }

    private func failedChange(
        command: String, status: Int32, previousPlist: Data?) async -> (enabled: Bool?, error: String?)
    {
        var message = String(localized: """
        Could not enable Launch at Login. Check OpenClaw in System Settings → General → Login Items and try again.
        """)
        message += " (launchctl \(command): \(status))"
        do {
            try await Self.restorePlist(previousPlist, at: self.plistURL)
        } catch {
            message += " " + String(localized:
                "The previous login item could not be restored. Check ~/Library/LaunchAgents before retrying.")
        }
        let current = await Self.readStatus(
            plistURL: self.plistURL, profile: AppProfile(environment: [:]), runLaunchctl: self.runLaunchctl)
        return (current, message)
    }

    @concurrent
    private static func restorePlist(_ previousPlist: Data?, at url: URL) async throws {
        if let previousPlist {
            try previousPlist.write(to: url, options: .atomic)
        } else {
            try await self.persist(enabled: false, bundlePath: "", plistURL: url)
        }
    }

    @concurrent
    private static func persist(enabled: Bool, bundlePath: String, plistURL: URL) async throws {
        if enabled {
            try FileManager.default.createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try self.plistContents(bundlePath: bundlePath).write(to: plistURL, options: .atomic)
        } else {
            // Removing future autostart must not terminate the running login job.
            do {
                try FileManager.default.removeItem(at: plistURL)
            } catch let error as CocoaError where error.code == .fileNoSuchFile {
                return
            }
        }
    }

    nonisolated static func plistContents(
        bundlePath: String,
        preferredPaths: [String] = CommandResolver.preferredPaths()) throws -> Data
    {
        var environment = ["PATH": preferredPaths.joined(separator: ":")]
        for key in ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] {
            environment[key] = OpenClawEnv.path(key)
        }
        let plist: [String: Any] = [
            "Label": "ai.openclaw.mac",
            "ProgramArguments": ["\(bundlePath)/Contents/MacOS/OpenClaw"],
            "WorkingDirectory": FileManager().homeDirectoryForCurrentUser.path,
            "RunAtLoad": true,
            "EnvironmentVariables": environment,
            "StandardOutPath": LogLocator.launchdLogPath,
            "StandardErrorPath": LogLocator.launchdLogPath,
        ]
        return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    }

    @discardableResult
    @concurrent
    private static func executeLaunchctl(_ args: [String]) async -> Int32 {
        await (try? BoundedProcess.run(
            path: "/bin/launchctl",
            arguments: args,
            timeout: 5).terminationStatus) ?? -1
    }
}
