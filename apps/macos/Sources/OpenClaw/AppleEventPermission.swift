import AppKit
import ApplicationServices
import Foundation
import OSLog

enum AppleEventPermissionState: Equatable, Sendable {
    case authorized
    case notDetermined
    case denied
    case targetNotRunning
    case targetNotAccessible
    case failed(OSStatus)
}

/// Runs the blocking Apple Event permission check off the Swift cooperative
/// thread pool and coalesces concurrent callers onto one in-flight probe.
///
/// `AEDeterminePermissionToAutomateTarget` blocks the calling thread until the
/// target app answers (and, when asking, until the user answers tccd). Running
/// it from `Task.detached` pins a cooperative-pool thread for that whole time.
/// Node refreshes fire from several notifications, so a slow target under load
/// stacked enough blocked probes to exhaust the pool; every other async task in
/// the app (gateway websocket receive, status item, node commands) then stalled
/// until the process was killed. Dispatching to a dedicated serial queue keeps
/// the pool free, single-flighting bounds the number of blocked threads to one,
/// and a timeout on passive checks turns a hung probe into `.failed` instead of
/// a wedge.
actor AppleEventPermissionProbeCoordinator {
    typealias DeterminePermission = AppleEventPermissionProbe.DeterminePermission

    static let shared = AppleEventPermissionProbeCoordinator()

    private let queue = DispatchQueue(
        label: "ai.openclaw.apple-event-permission",
        qos: .userInitiated)
    private var inFlight: [Bool: Task<OSStatus, Never>] = [:]

    init() {}

    func status(
        askUserIfNeeded: Bool,
        timeout: Duration?,
        determinePermission: @escaping DeterminePermission) async -> OSStatus
    {
        if let pending = self.inFlight[askUserIfNeeded] {
            return await pending.value
        }
        let queue = self.queue
        let task = Task<OSStatus, Never> {
            await Self.determine(
                askUserIfNeeded: askUserIfNeeded,
                timeout: timeout,
                on: queue,
                determinePermission: determinePermission)
        }
        self.inFlight[askUserIfNeeded] = task
        let status = await task.value
        if self.inFlight[askUserIfNeeded] == task {
            self.inFlight[askUserIfNeeded] = nil
        }
        return status
    }

    private static func determine(
        askUserIfNeeded: Bool,
        timeout: Duration?,
        on queue: DispatchQueue,
        determinePermission: @escaping DeterminePermission) async -> OSStatus
    {
        let box = ResumeOnce()
        return await withCheckedContinuation { (continuation: CheckedContinuation<OSStatus, Never>) in
            box.attach(continuation)
            queue.async {
                box.resume(with: determinePermission(askUserIfNeeded))
            }
            guard let timeout else { return }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout.dispatchInterval) {
                box.resume(with: AppleEventPermissionProbe.timedOutStatus)
            }
        }
    }

    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<OSStatus, Never>?

        func attach(_ continuation: CheckedContinuation<OSStatus, Never>) {
            self.lock.withLock { self.continuation = continuation }
        }

        func resume(with status: OSStatus) {
            let continuation = self.lock.withLock {
                defer { self.continuation = nil }
                return self.continuation
            }
            continuation?.resume(returning: status)
        }
    }
}

struct AppleEventPermissionProbe: Sendable {
    typealias DeterminePermission = @Sendable (_ askUserIfNeeded: Bool) -> OSStatus

    /// Passive (non-prompting) checks should answer well within this; a target
    /// app that does not service Apple Events for longer is reported as
    /// `.failed(errAETimeout)`, which the capability layer maps to `.unknown`.
    static let defaultPassiveTimeout: Duration = .seconds(10)
    static let timedOutStatus = OSStatus(errAETimeout)

    private let determinePermission: DeterminePermission
    private let passiveTimeout: Duration?
    private let coordinator: AppleEventPermissionProbeCoordinator

    init(
        determinePermission: @escaping DeterminePermission,
        passiveTimeout: Duration? = Self.defaultPassiveTimeout,
        coordinator: AppleEventPermissionProbeCoordinator = .shared)
    {
        self.determinePermission = determinePermission
        self.passiveTimeout = passiveTimeout
        self.coordinator = coordinator
    }

    static var live: Self {
        Self(determinePermission: { askUserIfNeeded in
            Self.determineTerminalPermission(askUserIfNeeded: askUserIfNeeded)
        })
    }

    func state(askUserIfNeeded: Bool) async -> AppleEventPermissionState {
        // Prompting waits on the user; only passive checks are bounded.
        let status = await self.coordinator.status(
            askUserIfNeeded: askUserIfNeeded,
            timeout: askUserIfNeeded ? nil : self.passiveTimeout,
            determinePermission: self.determinePermission)
        return Self.state(for: status)
    }

    static func state(for status: OSStatus) -> AppleEventPermissionState {
        switch status {
        case noErr:
            .authorized
        case OSStatus(errAEEventWouldRequireUserConsent):
            .notDetermined
        case OSStatus(errAEEventNotPermitted):
            .denied
        case OSStatus(procNotFound):
            .targetNotRunning
        case OSStatus(errAETargetAddressNotPermitted):
            .targetNotAccessible
        default:
            .failed(status)
        }
    }

    private static func determineTerminalPermission(askUserIfNeeded: Bool) -> OSStatus {
        let bundleID = Data("com.apple.Terminal".utf8)
        var target = AEAddressDesc()
        let createStatus = bundleID.withUnsafeBytes { bytes in
            AECreateDesc(
                typeApplicationBundleID,
                bytes.baseAddress,
                bundleID.count,
                &target)
        }
        guard createStatus == noErr else { return OSStatus(createStatus) }
        defer { AEDisposeDesc(&target) }

        return AEDeterminePermissionToAutomateTarget(
            &target,
            typeWildCard,
            typeWildCard,
            askUserIfNeeded)
    }
}

enum TerminalAutomationPermission {
    typealias LaunchTerminal = @MainActor () async -> Bool
    typealias OpenAutomationSettings = @MainActor () -> Void

    private static let logger = Logger(subsystem: "ai.openclaw", category: "TerminalAutomationPermission")
    private static let terminalBundleID = "com.apple.Terminal"

    static func authorizationStatus(
        probe: AppleEventPermissionProbe = .live) async -> CapabilityAuthorizationStatus
    {
        let state = await probe.state(askUserIfNeeded: false)
        return self.authorizationStatus(for: state)
    }

    static func authorizationStatus(for state: AppleEventPermissionState) -> CapabilityAuthorizationStatus {
        switch state {
        case .authorized:
            .granted
        case .notDetermined, .denied:
            .notGranted
        case .targetNotRunning, .targetNotAccessible, .failed:
            .unknown
        }
    }

    static func isAuthorized(probe: AppleEventPermissionProbe = .live) async -> Bool {
        await self.authorizationStatus(probe: probe).isGranted
    }

    @MainActor
    static func requestAuthorization(
        probe: AppleEventPermissionProbe = .live,
        launchTerminal: @escaping LaunchTerminal = Self.launchTerminal,
        openAutomationSettings: @escaping OpenAutomationSettings = Self.openAutomationSettings) async -> Bool
    {
        var state = await probe.state(askUserIfNeeded: false)
        if state == .authorized { return true }

        if state == .targetNotRunning {
            guard await launchTerminal() else { return false }
            state = await probe.state(askUserIfNeeded: false)
        }

        switch state {
        case .authorized:
            return true
        case .notDetermined:
            return await probe.state(askUserIfNeeded: true) == .authorized
        case .denied:
            openAutomationSettings()
            return false
        case .targetNotRunning:
            Self.logger.error("Terminal did not become available for Automation permission")
            return false
        case .targetNotAccessible:
            Self.logger.error("Terminal Automation target is not accessible")
            return false
        case let .failed(status):
            Self.logger.error("Terminal Automation permission check failed status=\(status, privacy: .public)")
            return false
        }
    }

    @MainActor
    private static func launchTerminal() async -> Bool {
        if !NSRunningApplication.runningApplications(withBundleIdentifier: self.terminalBundleID).isEmpty {
            return true
        }
        guard let terminalURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: self.terminalBundleID) else {
            return false
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.hides = true
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: terminalURL, configuration: configuration) { application, error in
                continuation.resume(returning: application != nil && error == nil)
            }
        }
    }

    @MainActor
    private static func openAutomationSettings() {
        SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: .appleScript))
    }
}

extension Duration {
    fileprivate var dispatchInterval: DispatchTimeInterval {
        let (seconds, attoseconds) = self.components
        let nanoseconds = seconds * 1_000_000_000 + attoseconds / 1_000_000_000
        return .nanoseconds(Int(clamping: nanoseconds))
    }
}
