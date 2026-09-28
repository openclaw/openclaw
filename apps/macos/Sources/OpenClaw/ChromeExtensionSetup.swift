import Foundation
import OpenClawKit
import OSLog

@MainActor
final class ChromeExtensionSetup {
    static let shared = ChromeExtensionSetup()
    nonisolated static func arguments(action: ChromeExtensionSetupAction) -> [String] {
        [
            "browser", "extension", "setup", "--action", action.rawValue,
            "--json", "--wait-ms", "1000",
        ]
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "ChromeExtensionSetup")
    private let requests = DeviceSettingsRequestQueue()
    private let performAction: @MainActor (
        ChromeExtensionSetupAction, @escaping @MainActor () -> Bool) async throws -> Result
    private var observer: NSObjectProtocol?
    private var notificationCenter: NotificationCenter?
    private var manualReplies: [UUID: CheckedContinuation<Result, Error>] = [:]
    private var manualTasks: [UUID: Task<Result, Error>] = [:]

    init(performAction: (@MainActor (ChromeExtensionSetupAction) async throws -> Result)? = nil) {
        if let performAction {
            self.performAction = { action, _ in try await performAction(action) }
        } else {
            self.performAction = { action, isCurrent in try await Self.runAction(action: action, isCurrent: isCurrent) }
        }
    }

    struct LegacyInstallation: Encodable, Equatable {
        let nativeHostRegistered: Bool
        let installRequested: Bool
        let installedProfiles: Int
        let discoveredProfiles: Int
    }

    /// Decode and re-encode only the public setup projection, never installer paths or credentials.
    struct Result: Codable, Equatable {
        var legacyInstallation: LegacyInstallation {
            LegacyInstallation(
                nativeHostRegistered: self.installation.nativeHostRegistered,
                installRequested: self.installation.installRequested,
                installedProfiles: self.installation.installedProfiles,
                discoveredProfiles: self.installation.discoveredProfiles)
        }

        struct Target: Codable, Equatable {
            let kind: String
            let platform: String
            let hostname: String
            let profile: String
            let relayPort: Int
        }

        struct Installation: Codable, Equatable {
            let nativeHostRegistered: Bool
            let installRequested: Bool
            let installedProfiles: Int
            let discoveredProfiles: Int
            let awaitingApproval: Bool
            let automaticBootstrapSupported: Bool
        }

        struct Connection: Codable, Equatable {
            enum State: String, Codable {
                case notChecked = "not_checked", unavailable
                case waitingForExtension = "waiting_for_extension", connected
            }

            let state: State
            let extensionVersion: String?
        }

        enum Phase: String, Codable {
            case inspectionRequired = "inspection_required", preparing
            case needsBrowserAction = "needs_browser_action", waitingForConnection = "waiting_for_connection"
            case ready, blocked
        }

        enum NextAction: String, Codable {
            case none, install, openChrome = "open_chrome", approveExtension = "approve_extension"
            case installFromStore = "install_from_store", checkConnection = "check_connection"
            case repairNativeHost = "repair_native_host", unsupported
        }

        let action: ChromeExtensionSetupAction
        let target: Target
        let phase: Phase
        let reason: String
        let installation: Installation
        let connection: Connection
        let nextAction: NextAction
    }

    enum SetupError: LocalizedError {
        case missingCLI, unavailable, retired

        var errorDescription: String? {
            switch self {
            case .missingCLI: "Install the OpenClaw CLI on this Mac, then try setup again."
            case .unavailable:
                "Chrome setup could not finish. Run openclaw browser extension setup on this Mac for details."
            case .retired: "The device settings document is no longer available."
            }
        }
    }

    static func readResult(_ stdout: String, action: ChromeExtensionSetupAction) throws -> Result {
        let result = try JSONDecoder().decode(Result.self, from: Data(stdout.utf8))
        let profile = result.target.profile
        guard result.action == action, result.target.kind == "local-host", result.target.platform == "darwin",
              profile.range(of: "\\A[a-z0-9][a-z0-9-]{0,63}\\z", options: .regularExpression) != nil,
              (1...65535).contains(result.target.relayPort),
              !result.target.hostname.isEmpty, result.target.hostname.count <= 255,
              result.installation.discoveredProfiles >= 0,
              result.installation.installedProfiles >= result.installation.discoveredProfiles,
              result.reason.range(of: "^[a-z][a-z0-9_]{0,79}$", options: .regularExpression) != nil,
              result.connection.extensionVersion.map({ $0.count <= 128 }) ?? true
        else { throw SetupError.unavailable }
        return result
    }

    func start(
        plan: AppLaunchRuntimePlan = .current,
        profile: AppProfile = .current,
        center: NotificationCenter = .default)
    {
        // Chrome's per-user manifest is shared across app profiles. Only the default
        // app may claim it automatically; named profiles retain explicit CLI/manual setup.
        guard !plan.isElevationHost, !profile.isActive, self.observer == nil else { return }
        self.notificationCenter = center
        self.observer = center.addObserver(forName: .openclawCLIInstalled, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.observer != nil else { return }
                self.requestAutomaticSetup()
            }
        }
        self.requestAutomaticSetup()
    }

    func stop() {
        if let observer {
            self.notificationCenter?.removeObserver(observer)
        }
        observer = nil
        self.notificationCenter = nil
        self.requests.cancel()
        for task in self.manualTasks.values {
            task.cancel()
        }
        let replies = Array(manualReplies.values)
        self.manualReplies.removeAll()
        for reply in replies {
            reply.resume(throwing: SetupError.retired)
        }
    }

    isolated deinit {
        self.stop()
    }

    private func requestAutomaticSetup() {
        self.requests.enqueue {
            do {
                let result = try await self.performAction(.install) { self.observer != nil }
                guard !Task.isCancelled else { return }
                Self.logger.info(
                    "Chrome setup: registered=\(result.installation.nativeHostRegistered)")
            } catch {
                guard !Task.isCancelled else { return }
                Self.logger.warning(
                    "Automatic Chrome setup needs retry: \(error.localizedDescription, privacy: .private)")
            }
        }
    }

    func run(action: ChromeExtensionSetupAction, isCurrent: @escaping @MainActor () -> Bool) async throws -> Result {
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        // Share one writer with startup and runtime updates. A retired dashboard may not start a queued write.
        let id = UUID()
        let result: Result = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: SetupError.retired)
                    return
                }
                self.manualReplies[id] = continuation
                self.requests.enqueue {
                    guard self.manualReplies[id] != nil, isCurrent(), !Task.isCancelled else {
                        self.manualReplies.removeValue(forKey: id)?.resume(throwing: SetupError.retired)
                        return
                    }
                    let task = Task { try await self.performAction(action, isCurrent) }
                    self.manualTasks[id] = task
                    do {
                        let result = try await task.value
                        self.manualReplies.removeValue(forKey: id)?.resume(returning: result)
                    } catch {
                        self.manualReplies.removeValue(forKey: id)?.resume(throwing: error)
                    }
                    self.manualTasks.removeValue(forKey: id)
                }
            }
        } onCancel: {
            Task { @MainActor in
                self.manualTasks[id]?.cancel()
                self.manualReplies.removeValue(forKey: id)?.resume(throwing: SetupError.retired)
            }
        }
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        return result
    }

    private static func runAction(
        action: ChromeExtensionSetupAction,
        isCurrent: @MainActor () -> Bool) async throws -> Result
    {
        let launch = try await resolveLaunch(action: action)
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        var environment = ProcessInfo.processInfo.environment
        environment.merge(launch.environment, uniquingKeysWith: { _, explicit in explicit })
        let privateRuntimePath = launch.environment["PATH"].map { $0 + ":" } ?? ""
        environment["PATH"] = privateRuntimePath + CommandResolver.preferredPaths().joined(separator: ":")
        // Match the node worker profile/config, not the dashboard's remote Gateway or SSH target.
        environment["OPENCLAW_STATE_DIR"] = OpenClawPaths.stateDirURL.path
        environment["OPENCLAW_CONFIG_PATH"] = OpenClawPaths.configURL.path
        environment["OPENCLAW_NO_RESPAWN"] = "1"
        let output = await ShellExecutor.runDetailed(
            command: launch.command, cwd: launch.currentDirectoryURL?.path, env: environment, timeout: 60)
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        // Pending/blocked are successful canonical projections, not process failures.
        guard output.success, !output.timedOut,
              let result = try? readResult(output.stdout, action: action)
        else { throw SetupError.unavailable }
        return result
    }

    private static func resolveLaunch(action: ChromeExtensionSetupAction) async throws -> MacNodeHostWorkerLaunch {
        if Bundle.main.bundleURL.pathExtension == "app" {
            return try BundledNodeWorker.browserSetupLaunch(bundle: .main, action: action)
        }
        // The ordinary command resolver follows SSH Gateway settings. This action always owns this Mac.
        let executable: String? = if case let .ready(location, _) = await CLIInstaller.status() {
            location
        } else {
            CommandResolver.findExecutable(named: "openclaw", searchPaths: CommandResolver.preferredPaths())
        }
        guard let executable else { throw SetupError.missingCLI }
        return MacNodeHostWorkerLaunch(
            command: AppProfile.current.localCLICommand(
                prefix: [executable], arguments: self.arguments(action: action)),
            currentDirectoryURL: nil)
    }
}
