import AppKit
import Darwin
import Foundation
import Security

struct CloudWorkerHostConfiguration: Sendable {
    enum EnrollmentMode: String, Sendable {
        case connect
        case resume
    }

    let nodeExecutable: URL
    let runtimeDirectory: URL
    let stateDirectory: URL
    let desktopDirectory: URL
    let displayName: String
    let enrollmentMode: EnrollmentMode

    var cliURL: URL {
        self.runtimeDirectory.appendingPathComponent("node_modules/openclaw/openclaw.mjs")
    }

    var nodeArguments: [String] {
        let command = self.enrollmentMode == .connect
            ? ["connect", "--target-file", self.stateDirectory.appendingPathComponent("setup-code").path]
            : ["node", "run"]
        return [self.cliURL.path] + command + ["--ephemeral", "--display-name", self.displayName]
    }

    init(arguments: [String]) throws {
        let names: Set = [
            "--node-executable", "--runtime-dir", "--state-dir", "--desktop-dir", "--lease-id", "--display-name",
            "--enrollment-mode",
        ]
        guard arguments.count == names.count * 2 else {
            throw CloudWorkerHostError(
                "requires Node, runtime/state/desktop directories, lease ID, display name, and enrollment mode")
        }
        var values: [String: String] = [:]
        for index in stride(from: 0, to: arguments.count, by: 2) {
            let key = arguments[index]
            let value = arguments[index + 1]
            guard names.contains(key), values[key] == nil, !value.isEmpty,
                  !value.contains("\0"), value.utf8.count <= 4096
            else { throw CloudWorkerHostError("invalid or duplicate launch argument") }
            values[key] = value
        }
        func absoluteURL(_ name: String) throws -> URL {
            guard let path = values[name], path.hasPrefix("/") else {
                throw CloudWorkerHostError("\(name) must be an absolute path")
            }
            return URL(fileURLWithPath: path).standardizedFileURL
        }
        self.nodeExecutable = try absoluteURL("--node-executable")
        self.runtimeDirectory = try absoluteURL("--runtime-dir")
        self.stateDirectory = try absoluteURL("--state-dir")
        self.desktopDirectory = try absoluteURL("--desktop-dir")
        guard let leaseID = values["--lease-id"],
              leaseID.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,131}$", options: .regularExpression) != nil,
              self.stateDirectory.lastPathComponent == leaseID,
              self.desktopDirectory.lastPathComponent == leaseID,
              let displayName = values["--display-name"], displayName.utf8.count <= 256,
              let mode = values["--enrollment-mode"].flatMap(EnrollmentMode.init(rawValue:))
        else { throw CloudWorkerHostError("invalid lease, display name, or enrollment mode") }
        self.displayName = displayName
        self.enrollmentMode = mode
    }

    func validateFiles() throws {
        let files = FileManager.default
        guard files.isExecutableFile(atPath: self.nodeExecutable.path),
              files.isReadableFile(atPath: self.cliURL.path)
        else { throw CloudWorkerHostError("the prepared Node runtime is missing; reprovision this worker") }
        for directory in [self.stateDirectory, self.desktopDirectory] {
            var info = stat()
            guard lstat(directory.path, &info) == 0,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700
            else { throw CloudWorkerHostError("lease state and desktop directories must be owned with mode 0700") }
        }
        if self.enrollmentMode == .connect,
           !files.isReadableFile(atPath: self.stateDirectory.appendingPathComponent("setup-code").path)
        {
            throw CloudWorkerHostError("the cloud enrollment target is missing; reprovision this worker")
        }
    }
}

struct CloudWorkerHostError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        "OpenClaw cloud worker host: \(self.message)"
    }
}

/// Runs only the cloud node and its signed-app-owned CUA daemon, without app pairing or Gateway startup.
enum CloudWorkerHost {
    static let argument = "--cloud-worker-host"
    static let inspectArgument = "--cloud-worker-inspect-process"
    static let bundleIdentifier = "ai.openclaw.cloud-worker"

    static func runIfRequested(arguments: [String], bundle: Bundle) -> Int32? {
        let isCloudHost = bundle.bundleIdentifier == self.bundleIdentifier
        guard isCloudHost || arguments.dropFirst()
            .contains(where: { $0 == self.argument || $0 == self.inspectArgument })
        else { return nil }
        guard isCloudHost, bundle.object(forInfoDictionaryKey: "OpenClawCloudWorkerHostVersion") as? Int == 1 else {
            fputs("Cloud workers require the separately signed OpenClaw Cloud Worker app\n", stderr)
            return 2
        }
        let mode = arguments.dropFirst().first
        guard mode == self.argument || mode == self.inspectArgument else {
            fputs("OpenClaw Cloud Worker requires a managed --cloud-worker-host invocation\n", stderr)
            return 2
        }
        let configuration: CloudWorkerHostConfiguration
        do {
            if mode == self.inspectArgument {
                guard (3...4).contains(arguments.count), let pid = Int32(arguments[2]), pid > 0 else {
                    throw CloudWorkerHostError("process inspection requires a host PID and optional child PID")
                }
                let nodePid = arguments.count == 4 ? Int32(arguments[3]) : nil
                guard arguments.count == 3 || (nodePid.map { $0 > 0 } == true) else {
                    throw CloudWorkerHostError("process inspection requires a positive child PID")
                }
                try self.verifySignature()
                try self.inspectProcess(pid: pid, nodePid: nodePid, bundle: bundle)
                return 0
            }
            configuration = try CloudWorkerHostConfiguration(arguments: Array(arguments.dropFirst(2)))
            try configuration.validateFiles()
            try self.verifySignature()
            // LaunchServices owns app launch; the host owns the cwd bound into its process receipt.
            guard FileManager.default.changeCurrentDirectoryPath(configuration.runtimeDirectory.path) else {
                throw CloudWorkerHostError("could not enter the prepared Node runtime; reprovision this worker")
            }
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            return 2
        }
        MainActor.assumeIsolated {
            NSApplication.shared.setActivationPolicy(.prohibited)
            _ = Task { @MainActor in
                do {
                    let result = try await self.run(configuration)
                    Darwin.exit(result)
                } catch {
                    fputs("\(error.localizedDescription)\n", stderr)
                    Darwin.exit(1)
                }
            }
            NSApplication.shared.run()
        }
        return 1
    }

    private enum Inspection: Encodable {
        case gone
        case active(host: ProcessIdentity, node: ProcessIdentity?)

        private enum CodingKeys: String, CodingKey { case state, host, node }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .gone:
                try container.encode("gone", forKey: .state)
            case let .active(host, node):
                try container.encode("active", forKey: .state)
                try container.encode(host, forKey: .host)
                try container.encodeIfPresent(node, forKey: .node)
            }
        }
    }

    private static func inspectProcess(pid: Int32, nodePid: Int32?, bundle: Bundle) throws {
        guard let host = try ProcessIdentity.read(pid: pid) else {
            try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(Inspection.gone))
            return
        }
        guard let executableURL = bundle.executableURL,
              URL(fileURLWithPath: host.executablePath).resolvingSymlinksInPath() ==
              executableURL.resolvingSymlinksInPath(),
              host.arguments.dropFirst().first == self.argument
        else { throw CloudWorkerHostError("the process is not a readable cloud worker host") }
        let node = try nodePid.flatMap { try ProcessIdentity.read(pid: $0) }
        guard node.map({ $0.parentPid == host.pid && $0.uid == host.uid }) ?? true,
              try host.isCurrent(), try node?.isCurrent() ?? true
        else { throw CloudWorkerHostError("the cloud worker process owner changed during inspection") }
        try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(Inspection.active(host: host, node: node)))
    }

    private static func verifySignature() throws {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        var requirement: SecRequirement?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess,
              let code,
              SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let staticCode,
              SecCodeCopySigningInformation(
                  staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information,
              let team = (information as NSDictionary)[kSecCodeInfoTeamIdentifier] as? String,
              let requirementText = ApplicationRelocator.developerIDRequirementString(
                  bundleIdentifier: self.bundleIdentifier, teamIdentifier: team),
              SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement,
              SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess,
              let securedInfo = (information as NSDictionary)[kSecCodeInfoPList] as? NSDictionary,
              securedInfo["OpenClawCloudWorkerHostVersion"] as? Int == 1
        else {
            throw CloudWorkerHostError("the cloud host requires its dedicated, intact Developer ID signature")
        }
    }

    @MainActor private static func run(_ configuration: CloudWorkerHostConfiguration) async throws -> Int32 {
        guard CuaDriverArtifact.bundledExecutableURL != nil else {
            throw CloudWorkerHostError(
                "install the signed OpenClaw Cloud Worker app with its bundled CUA driver in the worker image")
        }
        let desktop = LiveMacDesktopAvailabilityPlatform()
        try await self.verifyDesktopAccess(desktop)
        let node = CloudWorkerNodeProcess(configuration: configuration)
        let notifications = NotificationCenter()
        let driver = CuaDriverHostCoordinator(
            notificationCenter: notifications,
            applicationSupportURL: { configuration.desktopDirectory },
            beforeDaemonStop: { await node.stop() })
        let session = CloudWorkerHostSession(
            node: node,
            driver: driver,
            notifications: notifications,
            platform: desktop,
            prepareNode: {
                try await self.verifyDesktopAccess(desktop)
                let wallpaper = configuration.desktopDirectory.appendingPathComponent("wallpaper.png")
                if FileManager.default.fileExists(atPath: wallpaper.path) {
                    for screen in NSScreen.screens {
                        try NSWorkspace.shared.setDesktopImageURL(wallpaper, for: screen, options: [:])
                    }
                }
            })
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler {
                Task { @MainActor in session.requestStop(reason: "host shutdown requested") }
            }
            source.resume()
            signals.append(source)
        }
        defer { signals.forEach { $0.cancel() } }
        return await session.run()
    }

    @MainActor private static func verifyDesktopAccess(_ desktop: LiveMacDesktopAvailabilityPlatform) async throws {
        let permissions = await PermissionManager.authorizationStatus([.accessibility, .screenRecording])
        guard permissions[.accessibility] == .granted, permissions[.screenRecording] == .granted else {
            throw CloudWorkerHostError(
                "grant Accessibility and Screen Recording to OpenClaw Cloud Worker in the worker image")
        }
        guard desktop.consoleState() == .unlocked else {
            throw CloudWorkerHostError("sign in and unlock the worker account's macOS desktop before dispatch")
        }
    }
}

@MainActor
final class CloudWorkerNodeProcess {
    private let configuration: CloudWorkerHostConfiguration
    private let process = Process()

    init(configuration: CloudWorkerHostConfiguration) {
        self.configuration = configuration
    }

    var isRunning: Bool {
        self.process.isRunning
    }

    func start(endpoint: CuaDriverWorkerEndpoint, onExit: @escaping @Sendable (Int32) -> Void) throws {
        var environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !CuaDriverWorkerEnvironment.inheritedFamilyPrefixes.contains(where: key.hasPrefix) &&
                ![
                    "OPENCLAW_PROFILE",
                    "OPENCLAW_CONFIG_PATH",
                    "CUA_TELEMETRY_ENABLED",
                    "CRABBOX_WORKER_SETUP_CODE",
                    "CRABBOX_WORKER_BOOTSTRAP_TOKEN",
                ].contains(key)
        }
        environment["OPENCLAW_STATE_DIR"] = self.configuration.stateDirectory.path
        environment[CuaDriverWorkerEnvironment.endpoint] = try endpoint.environmentValue()
        self.process.executableURL = self.configuration.nodeExecutable
        self.process.arguments = self.configuration.nodeArguments
        self.process.currentDirectoryURL = self.configuration.runtimeDirectory
        self.process.environment = environment
        self.process.standardInput = FileHandle.nullDevice
        self.process.standardOutput = FileHandle.standardOutput
        self.process.standardError = FileHandle.standardError
        self.process.terminationHandler = { onExit($0.terminationStatus) }
        try self.process.run()
        do {
            try self.publishLaunchReceipt()
        } catch {
            if self.process.isRunning { self.process.terminate() }
            throw error
        }
        fputs("OPENCLAW_CLOUD_NODE_PID=\(self.process.processIdentifier)\n", stderr)
    }

    private func publishLaunchReceipt() throws {
        guard let node = try ProcessIdentity.birth(pid: self.process.processIdentifier),
              let host = try ProcessIdentity.birth(pid: getpid()),
              node.parentPid == host.pid, node.uid == host.uid
        else { throw CloudWorkerHostError("could not identify the cloud node launch; reprovision this worker") }
        let receipt: [String: Any] = [
            "pid": node.pid,
            "startTime": node.startTime,
            "runtimeDir": self.configuration.runtimeDirectory.path,
            "stateDir": self.configuration.stateDirectory.path,
            "cli": self.configuration.cliURL.path,
            "hostPid": host.pid,
            "hostStartTime": host.startTime,
        ]
        guard self.process.isRunning else { throw CloudWorkerHostError("the cloud node exited before enrollment") }
        let root = self.configuration.stateDirectory
        // Publish the identity record before the PID used by enrollment replay.
        try JSONSerialization.data(withJSONObject: receipt)
            .write(to: root.appendingPathComponent("node-launch.json"), options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: root.appendingPathComponent("node-launch.json").path)
        try Data("\(self.process.processIdentifier)\n".utf8)
            .write(to: root.appendingPathComponent("node.pid"), options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: root.appendingPathComponent("node.pid").path)
    }

    func stop() async {
        guard self.process.isRunning else { return }
        self.process.terminate()
        let deadline = ContinuousClock.now + .seconds(10)
        while self.process.isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        if self.process.isRunning {
            Darwin.kill(self.process.processIdentifier, SIGKILL)
            while self.process.isRunning {
                try? await Task.sleep(for: .milliseconds(25))
            }
        }
    }
}

@MainActor
final class CloudWorkerHostSession {
    private let node: CloudWorkerNodeProcess
    private let driver: CuaDriverHostCoordinator
    private let notifications: NotificationCenter
    private let platform: any MacDesktopAvailabilityPlatform
    private let idleAssertion: MacDesktopIdleAssertion
    private let prepareNode: @MainActor () async throws -> Void
    private var stopMonitoring: (@MainActor () -> Void)?
    private var observer: NSObjectProtocol?
    private var completion: CheckedContinuation<Int32, Never>?
    private var stopping = false

    init(
        node: CloudWorkerNodeProcess,
        driver: CuaDriverHostCoordinator,
        notifications: NotificationCenter,
        platform: any MacDesktopAvailabilityPlatform,
        prepareNode: @escaping @MainActor () async throws -> Void)
    {
        self.node = node
        self.driver = driver
        self.notifications = notifications
        self.platform = platform
        self.idleAssertion = MacDesktopIdleAssertion(platform: platform)
        self.prepareNode = prepareNode
    }

    func run() async -> Int32 {
        await withCheckedContinuation { continuation in
            self.completion = continuation
            guard self.refreshDesktop() else { return }
            self.stopMonitoring = self.platform.startMonitoring { [weak self] in
                _ = self?.refreshDesktop()
            }
            self.observer = self.notifications.addObserver(
                forName: .openclawCuaDriverAvailabilityChanged, object: nil, queue: .main)
            { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.node.isRunning, self.driver.workerEndpoint == nil else { return }
                    self.requestStop(reason: "CUA driver stopped; reprovision the worker before resuming computer use")
                }
            }
            Task { @MainActor [self] in
                await self.driver.setEnabled(true)
                guard !self.stopping else { return }
                do {
                    try await self.prepareNode()
                    guard self.refreshDesktop() else { return }
                    guard let endpoint = self.driver.workerEndpoint else {
                        self.requestStop(reason: "the app-owned CUA driver did not become ready")
                        return
                    }
                    try self.node.start(endpoint: endpoint) { [weak self] exitCode in
                        Task { @MainActor in self?.finish(exitCode) }
                    }
                } catch {
                    self.requestStop(reason: error.localizedDescription)
                }
            }
        }
    }

    private func refreshDesktop() -> Bool {
        guard !self.stopping else { return false }
        guard self.platform.consoleState() == .unlocked else {
            self.requestStop(reason: "the worker desktop was locked or its GUI session ended")
            return false
        }
        guard self.idleAssertion.refresh() else {
            self.requestStop(reason: "macOS could not keep the worker desktop awake")
            return false
        }
        return true
    }

    func requestStop(reason: String) {
        guard !self.stopping else { return }
        fputs("OpenClaw cloud worker host: \(reason)\n", stderr)
        self.finish(1)
    }

    private func finish(_ exitCode: Int32) {
        guard !self.stopping else { return }
        self.stopping = true
        self.stopMonitoring?()
        self.stopMonitoring = nil
        self.idleAssertion.retire()
        if let observer = self.observer { self.notifications.removeObserver(observer) }
        self.observer = nil
        Task { @MainActor in
            await self.node.stop()
            await self.driver.shutdown()
            self.completion?.resume(returning: exitCode)
            self.completion = nil
        }
    }
}
