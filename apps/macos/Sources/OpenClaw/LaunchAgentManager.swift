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
        profile: AppProfile = .current) -> Task<Bool, Never>
    {
        // Reserve user-event order before creating async work; startup hydration
        // cannot overwrite a choice while its launchctl operation is pending.
        self.generation &+= 1
        let generation = self.generation
        let previous = self.mutationTail
        let task = Task {
            await previous?.value
            return await self.apply(
                enabled: enabled,
                bundlePath: bundlePath,
                profile: profile,
                generation: generation)
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
        generation: UInt64) async -> Bool
    {
        guard self.generation == generation else { return false }
        guard !profile.isActive else {
            Self.logger.info("login-agent change skipped (unavailable under app profile)")
            return false
        }
        do {
            try await Self.persist(enabled: enabled, bundlePath: bundlePath, plistURL: self.plistURL)
        } catch {
            Self.logger.error("login-agent persistence failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
        guard self.generation == generation else { return false }
        guard enabled else { return true }
        let alreadyLoaded = await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"]) == 0
        guard self.generation == generation else { return false }
        // Reinstalling a loaded login job would boot out the app that must bootstrap it again.
        guard !alreadyLoaded else { return false }
        for arguments in [
            ["bootout", "gui/\(getuid())/\(launchdLabel)"],
            ["bootstrap", "gui/\(getuid())", self.plistURL.path],
            ["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"],
        ] {
            guard self.generation == generation else { return false }
            _ = await self.runLaunchctl(arguments)
        }
        return true
    }

    @concurrent
    private static func persist(enabled: Bool, bundlePath: String, plistURL: URL) async throws {
        if enabled {
            try FileManager.default.createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let plist = self.plistContents(bundlePath: bundlePath)
            try plist.write(to: plistURL, atomically: true, encoding: .utf8)
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
        preferredPaths: [String] = CommandResolver.preferredPaths()) -> String
    {
        let path = self.escapePlistText(preferredPaths.joined(separator: ":"))
        let profileEnvironment = self.profileEnvironmentPlistEntries()
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>ai.openclaw.mac</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(self.escapePlistText(bundlePath))/Contents/MacOS/OpenClaw</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(self.escapePlistText(FileManager().homeDirectoryForCurrentUser.path))</string>
          <key>RunAtLoad</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>\(path)</string>\(profileEnvironment)
          </dict>
          <key>StandardOutPath</key>
          <string>\(self.escapePlistText(LogLocator.launchdLogPath))</string>
          <key>StandardErrorPath</key>
          <string>\(self.escapePlistText(LogLocator.launchdLogPath))</string>
        </dict>
        </plist>
        """
    }

    private nonisolated static func profileEnvironmentPlistEntries() -> String {
        ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"].compactMap { key in
            guard let value = OpenClawEnv.path(key) else { return nil }
            return """

                        <key>\(key)</key>
                        <string>\(self.escapePlistText(value))</string>
            """
        }.joined()
    }

    private nonisolated static func escapePlistText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    @discardableResult
    @concurrent
    private static func executeLaunchctl(_ args: [String]) async -> Int32 {
        do {
            return try await BoundedProcess.run(
                path: "/bin/launchctl",
                arguments: args,
                timeout: 5).terminationStatus
        } catch {
            return -1
        }
    }
}
