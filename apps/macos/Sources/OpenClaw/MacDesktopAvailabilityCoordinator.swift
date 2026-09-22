import Foundation
import OpenClawKit

@MainActor
final class MacDesktopAvailabilityCoordinator {
    typealias State = DeviceSettingsSnapshot.DesktopAvailability.State

    enum AvailabilityError: LocalizedError, Equatable {
        case locked
        case unknown
        case unavailable
        case executionClosed
        case capacity
        case assertionFailed

        var errorDescription: String? {
            switch self {
            case .locked:
                "COMPUTER_DESKTOP_LOCKED: unlock this Mac through its normal login screen"
            case .unknown:
                "COMPUTER_DESKTOP_UNKNOWN: the Mac could not verify its logged-in desktop session"
            case .unavailable:
                "COMPUTER_DESKTOP_UNAVAILABLE: the Mac desktop connection is no longer active"
            case .executionClosed:
                "COMPUTER_EXECUTION_CLOSED: start a new Computer execution after the desktop is available"
            case .capacity:
                "COMPUTER_DESKTOP_UNAVAILABLE: close previous Computer executions before starting another"
            case .assertionFailed:
                "COMPUTER_DESKTOP_UNAVAILABLE: macOS could not keep the desktop awake for Computer use"
            }
        }
    }

    struct Permit: Sendable, Equatable {
        let executionId: String?
        fileprivate let recordID: UUID
        fileprivate let routeGeneration: UInt64
        let inputScopeId: UUID
    }

    private enum Phase: Equatable {
        case active
        case revoked
        case cleaning
        case retired
        case closing
        case closedBeforeAdmission
    }

    private struct Execution {
        let permit: Permit
        let expiresAt: TimeInterval
        var phase: Phase
    }

    static let shared = MacDesktopAvailabilityCoordinator()
    static let unattendedEnabledKey = "desktopUnattendedHostingEnabled"
    private static let executionLifetime: TimeInterval = 3600
    private static let assertionLifetime: TimeInterval = 15
    private static let assertionRefreshInterval: TimeInterval = 5
    private static let maximumExecutions = 128

    private(set) var state: State = .unknown
    private(set) var unattendedEnabled: Bool
    var onStateChanged: (@MainActor (State) -> Void)?
    var onExecutionsRevoked: (@MainActor ([Permit], String) -> Void)?

    private let defaults: UserDefaults
    private let platform: any MacDesktopAvailabilityPlatform
    private var generation: UInt64?
    private var connected = false
    private var hostingEnabled = false
    private var executions: [UUID: Execution] = [:]
    private var legacyInputScopeID = UUID()
    private var legacyInputPermit: Permit?
    private var admissionOverflowed = false
    private var assertion: UInt32?
    private var assertionRefreshAt: TimeInterval = 0
    private var stopMonitoring: (@MainActor () -> Void)?

    init(
        defaults: UserDefaults = AppDefaults.standard,
        platform: (any MacDesktopAvailabilityPlatform)? = nil)
    {
        self.defaults = defaults
        self.platform = platform ?? LiveMacDesktopAvailabilityPlatform()
        self.unattendedEnabled = defaults.bool(forKey: Self.unattendedEnabledKey)
    }

    isolated deinit {
        self.stopMonitoring?()
        if let assertion = self.assertion { self.platform.releaseIdleAssertion(assertion) }
    }

    /// A retired route cannot be restored by a delayed callback with the same epoch.
    func setRoute(generation: UInt64, connected: Bool, hostingEnabled: Bool) {
        if let current = self.generation {
            guard generation >= current else { return }
            if generation == current, !self.connected, connected { return }
        }
        if self.generation != generation {
            self.retireRoute(reason: "route-replaced")
            self.generation = generation
        }
        self.connected = connected
        self.hostingEnabled = connected && hostingEnabled
        if !connected {
            self.retireRoute(reason: "route-disconnected")
        }
        self.updateMonitoring()
        self.refresh()
    }

    func setUnattendedEnabled(_ enabled: Bool) {
        self.unattendedEnabled = enabled
        self.defaults.set(enabled, forKey: Self.unattendedEnabledKey)
        self.refresh()
    }

    @discardableResult
    func refresh() -> State {
        let observed = self.platform.consoleState()
        let changed = observed != self.state
        self.state = observed
        if observed != .unlocked {
            self.revokeExecutions(reason: observed == .locked ? "desktop-locked" : "desktop-unknown")
        }
        let now = self.platform.uptime
        let expired = self.executions.values.filter { $0.phase == .active && $0.expiresAt <= now }
        self.revokeExecutions(expired.map(\.permit.recordID), reason: "execution-expired")
        self.reconcileAssertion(now: now)
        if changed { self.onStateChanged?(observed) }
        return observed
    }

    func admit(executionId: String?) throws -> Permit {
        self.refresh()
        try self.requireAvailable()
        if let executionId,
           let existing = self.executions.values.first(where: { $0.permit.executionId == executionId })
        {
            try self.validate(existing.permit)
            return existing.permit
        }
        guard !self.admissionOverflowed, self.executions.count < Self.maximumExecutions else {
            throw AvailabilityError.capacity
        }
        guard let generation = self.generation else { throw AvailabilityError.unavailable }
        let recordID = UUID()
        let permit = Permit(
            executionId: executionId,
            recordID: recordID,
            routeGeneration: generation,
            inputScopeId: executionId == nil ? self.legacyInputScopeID : recordID)
        if executionId == nil { self.legacyInputPermit = permit }
        self.executions[permit.recordID] = Execution(
            permit: permit,
            expiresAt: self.platform.uptime + Self.executionLifetime,
            phase: .active)
        // The reservation is visible before dispatch can suspend or a close can arrive.
        self.reconcileAssertion(now: self.platform.uptime)
        guard self.assertion != nil else {
            throw AvailabilityError.assertionFailed
        }
        return permit
    }

    func validate(_ permit: Permit) throws {
        self.refresh()
        try self.requireAvailable()
        guard permit.routeGeneration == self.generation,
              self.executions[permit.recordID]?.phase == .active
        else { throw AvailabilityError.executionClosed }
    }

    func finishInvocation(_ permit: Permit) {
        guard permit.executionId == nil, self.executions[permit.recordID]?.phase == .active else { return }
        self.executions.removeValue(forKey: permit.recordID)
        self.refresh()
    }

    func invalidate(_ permit: Permit, reason: String) {
        guard permit.routeGeneration == self.generation,
              self.executions[permit.recordID]?.phase == .active
        else { return }
        self.revokeExecutions([permit.recordID], reason: reason)
        self.refresh()
    }

    func isRevoked(_ permit: Permit) -> Bool {
        self.executions[permit.recordID]?.phase == .revoked
    }

    func beginRevocationCleanup(_ permit: Permit) -> Bool {
        guard self.isRevoked(permit) else { return false }
        self.executions[permit.recordID]?.phase = .cleaning
        return true
    }

    func finishRevocationCleanup(_ permit: Permit, succeeded: Bool) {
        guard self.executions[permit.recordID]?.phase == .cleaning else { return }
        if succeeded, permit.executionId == nil || permit.routeGeneration != self.generation {
            self.executions.removeValue(forKey: permit.recordID)
        } else {
            self.executions[permit.recordID]?.phase = succeeded ? .retired : .revoked
        }
    }

    func beginClose(executionId: String) -> Permit? {
        guard let execution = self.executions.values.first(where: { $0.permit.executionId == executionId }) else {
            guard self.connected, let generation = self.generation else { return nil }
            // A close can overtake the first admission while its service initialization awaits.
            guard self.executions.count < Self.maximumExecutions else {
                self.admissionOverflowed = true
                return nil
            }
            let recordID = UUID()
            let permit = Permit(
                executionId: executionId, recordID: recordID, routeGeneration: generation, inputScopeId: recordID)
            self.executions[permit.recordID] = Execution(
                permit: permit, expiresAt: self.platform.uptime, phase: .closedBeforeAdmission)
            return nil
        }
        guard execution.phase != .closedBeforeAdmission,
              execution.phase != .closing, execution.phase != .cleaning else { return nil }
        self.executions[execution.permit.recordID]?.phase = .closing
        self.refresh()
        return execution.permit
    }

    /// Call only after the provider's physical close succeeds; failed cleanup keeps its reservation.
    func finishClose(_ permit: Permit, succeeded: Bool = true) {
        guard self.executions[permit.recordID]?.phase == .closing else { return }
        if succeeded {
            self.executions.removeValue(forKey: permit.recordID)
        } else {
            self.executions[permit.recordID]?.phase = .revoked
        }
        self.refresh()
    }

    func revoke(generation: UInt64, reason: String) {
        guard generation == self.generation else { return }
        self.retireRoute(reason: reason)
        self.updateMonitoring()
    }

    func stop() {
        self.retireRoute(reason: "node-stopped")
        self.updateMonitoring()
    }

    private func requireAvailable() throws {
        guard self.connected, self.generation != nil else { throw AvailabilityError.unavailable }
        switch self.state {
        case .locked: throw AvailabilityError.locked
        case .unknown: throw AvailabilityError.unknown
        case .unlocked: break
        }
    }

    private func retireRoute(reason: String) {
        self.connected = false
        self.hostingEnabled = false
        self.revokeExecutions(reason: reason)
        // Keep cleanup reservations across route replacement until the physical owner finishes.
        self.executions = self.executions
            .filter { $0.value.phase != .retired && $0.value.phase != .closedBeforeAdmission }
        self.admissionOverflowed = false
        self.releaseAssertion()
    }

    private func revokeExecutions(_ ids: [UUID]? = nil, reason: String) {
        var candidates = ids ?? Array(self.executions.keys)
        if let legacy = self.legacyInputPermit,
           ids == nil || candidates.contains(where: { self.executions[$0]?.permit.inputScopeId == legacy.inputScopeId })
        {
            // Split no-ID mouse down/up calls share input ownership, but each power assertion is one-shot.
            if self.executions[legacy.recordID] == nil {
                self.executions[legacy.recordID] = Execution(
                    permit: legacy, expiresAt: self.platform.uptime, phase: .active)
            }
            self.legacyInputPermit = nil
            self.legacyInputScopeID = UUID()
            candidates.append(contentsOf: self.executions.values
                .filter { $0.permit.inputScopeId == legacy.inputScopeId }
                .map(\.permit.recordID))
        }
        var revoked: [Permit] = []
        for id in candidates where self.executions[id]?.phase == .active {
            self.executions[id]?.phase = .revoked
            if let permit = self.executions[id]?.permit { revoked.append(permit) }
        }
        if !revoked.isEmpty {
            self.releaseAssertion()
            self.onExecutionsRevoked?(revoked.sorted { ($0.executionId ?? "") < ($1.executionId ?? "") }, reason)
        }
    }

    private func reconcileAssertion(now: TimeInterval) {
        let active = self.executions.values.filter { $0.phase == .active }
        let unattended = self.unattendedEnabled && self.hostingEnabled
        guard self.connected, self.state == .unlocked, unattended || !active.isEmpty else {
            self.releaseAssertion()
            return
        }
        guard self.assertion == nil || now >= self.assertionRefreshAt else { return }
        let remaining = unattended ? Self.assertionLifetime :
            min(Self.assertionLifetime, (active.map(\.expiresAt).min() ?? now) - now)
        guard remaining > 0 else {
            self.releaseAssertion()
            return
        }
        let previous = self.assertion
        self.assertion = self.platform.makeIdleAssertion(timeout: remaining)
        if let previous { self.platform.releaseIdleAssertion(previous) }
        self.assertionRefreshAt = now + min(Self.assertionRefreshInterval, remaining)
        if self.assertion == nil {
            self.revokeExecutions(reason: "idle-assertion-unavailable")
        }
    }

    private func releaseAssertion() {
        guard let assertion = self.assertion else { return }
        self.assertion = nil
        self.platform.releaseIdleAssertion(assertion)
    }

    private func updateMonitoring() {
        if !self.connected {
            self.stopMonitoring?()
            self.stopMonitoring = nil
        } else if self.stopMonitoring == nil {
            self.stopMonitoring = self.platform.startMonitoring { [weak self] in self?.refresh() }
        }
    }
}
