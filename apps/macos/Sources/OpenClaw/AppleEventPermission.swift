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
/// thread pool, coalesces concurrent callers onto one in-flight probe, and
/// keeps that probe tracked until the native call really returns.
///
/// `AEDeterminePermissionToAutomateTarget` blocks the calling thread until the
/// target app answers (and, when asking, until the user answers tccd). Running
/// it from `Task.detached` pinned a cooperative-pool thread for that whole time.
/// Node refreshes fire from several notifications, so one unanswered probe let
/// later probes stack up until the pool was exhausted; every other async task in
/// the app (gateway websocket receive, status item, node commands) then stalled
/// until the process was killed.
///
/// The native call now runs on a private dispatch queue, so a hung probe costs
/// one queue thread instead of a pool thread. Callers of the same kind share the
/// in-flight operation, and passive callers give up after a deadline measured
/// from the operation's start. The operation itself stays in `inFlight` until it
/// returns, so a timed-out caller never enqueues a second native call behind the
/// hung one; later passive callers answer immediately with `errAETimeout` until
/// the target finally replies, after which the next probe runs fresh.
actor AppleEventPermissionProbeCoordinator {
    typealias DeterminePermission = AppleEventPermissionProbe.DeterminePermission

    static let shared = AppleEventPermissionProbeCoordinator()

    private static let logger = Logger(subsystem: "ai.openclaw", category: "AppleEventPermissionProbe")

    private struct Operation {
        let id: UUID
        let task: Task<OSStatus, Never>
        let startedAt: ContinuousClock.Instant
    }

    /// Concurrent so an interactive prompt is not queued behind a hung passive check.
    private let queue = DispatchQueue(
        label: "ai.openclaw.apple-event-permission",
        qos: .userInitiated,
        attributes: .concurrent)
    private var inFlight: [Bool: Operation] = [:]
    private var waiters: [Bool: Int] = [:]

    init() {}

    func status(
        askUserIfNeeded: Bool,
        timeout: Duration?,
        determinePermission: @escaping DeterminePermission) async -> OSStatus
    {
        let operation = self.operation(askUserIfNeeded: askUserIfNeeded, determinePermission: determinePermission)
        self.waiters[askUserIfNeeded, default: 0] += 1
        defer { self.waiters[askUserIfNeeded, default: 0] -= 1 }
        guard let timeout else {
            return await operation.task.value
        }
        let remaining = timeout - (ContinuousClock.now - operation.startedAt)
        guard remaining > .zero else {
            return AppleEventPermissionProbe.timedOutStatus
        }
        let status = await Self.value(of: operation.task, within: remaining)
        if status == AppleEventPermissionProbe.timedOutStatus, self.inFlight[askUserIfNeeded]?.id == operation.id {
            Self.logger.error(
                "probe ask=\(askUserIfNeeded) timed out after \(timeout, privacy: .public); operation retained")
        }
        return status
    }

    /// Callers currently parked on the in-flight probe of this kind.
    func waiterCount(askUserIfNeeded: Bool) -> Int {
        self.waiters[askUserIfNeeded] ?? 0
    }

    /// Whether a native probe of this kind is still running, timed-out callers included.
    func isProbeInFlight(askUserIfNeeded: Bool) -> Bool {
        self.inFlight[askUserIfNeeded] != nil
    }

    private func operation(
        askUserIfNeeded: Bool,
        determinePermission: @escaping DeterminePermission) -> Operation
    {
        if let pending = self.inFlight[askUserIfNeeded] {
            return pending
        }
        let id = UUID()
        let queue = self.queue
        let task = Task<OSStatus, Never>.detached(priority: .userInitiated) {
            let status = await withCheckedContinuation { (continuation: CheckedContinuation<OSStatus, Never>) in
                queue.async {
                    continuation.resume(returning: determinePermission(askUserIfNeeded))
                }
            }
            await self.finish(id: id, askUserIfNeeded: askUserIfNeeded, status: status)
            return status
        }
        let operation = Operation(id: id, task: task, startedAt: .now)
        self.inFlight[askUserIfNeeded] = operation
        return operation
    }

    private func finish(id: UUID, askUserIfNeeded: Bool, status: OSStatus) {
        guard let operation = self.inFlight[askUserIfNeeded], operation.id == id else { return }
        self.inFlight[askUserIfNeeded] = nil
        let elapsed = ContinuousClock.now - operation.startedAt
        Self.logger.info(
            "probe ask=\(askUserIfNeeded) returned \(status) after \(elapsed, privacy: .public)")
    }

    /// Resolves to the task's value or to `timedOutStatus`, whichever comes first.
    /// The task keeps running either way; only the waiting is bounded.
    private static func value(of task: Task<OSStatus, Never>, within timeout: Duration) async -> OSStatus {
        let box = ResumeOnce()
        return await withCheckedContinuation { (continuation: CheckedContinuation<OSStatus, Never>) in
            box.attach(continuation)
            let deadline = Task {
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                box.resume(with: AppleEventPermissionProbe.timedOutStatus)
            }
            Task {
                let status = await task.value
                deadline.cancel()
                box.resume(with: status)
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
