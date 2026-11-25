import Foundation
import Observation

/// OpenClaw ID setup shared by the Mac and iOS apps. Native enrollment owns credentials and
/// approval checks; views receive display data only.
/// Node approval and chat access are separate grants, never one six-digit ceremony.
@MainActor
public protocol OpenClawIDSetupService {
    var unavailableReason: String? { get }
    var accountUnavailableReason: String? { get }
    func start(_ intent: OpenClawIDSetupIntent) async throws -> OpenClawIDSetupStep
    func perform(_ action: OpenClawIDSetupAction) async throws -> OpenClawIDSetupStep
    func cancel()
}

extension OpenClawIDSetupService {
    public var accountUnavailableReason: String? {
        self.unavailableReason
    }
}

public enum OpenClawIDSetupIntent { case makeReachable, connect, joinNode }

public enum OpenClawIDSetupAction {
    case signIn, switchAccount, selectClaw(String), saveRecoveryKit, confirmRecoveryKit, requestNode, checkApproval,
         requestChat
    case pasteNodeInvitation(discoveryOrigin: String)
    case approveFromDevice, useRecoveryKit, chooseKitFile, retry, back
    /// Member join: open the invite step, read the copied invite link, send the request, or stop
    /// waiting and forget this device's request keys.
    case joinWithInvite, pasteInvite, requestJoin, cancelJoin
    /// The person's own comparison of the six digits on this device.
    case confirmCode(matches: Bool)
    /// The typed recovery code. It is passed straight to the enrollment and not kept in view state.
    case submitRecoveryKit(String)
}

public struct OpenClawIDSetupClaw: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let relationship: String
    public let online: Bool

    public init(id: String, name: String, relationship: String, online: Bool) {
        self.id = id
        self.name = name
        self.relationship = relationship
        self.online = online
    }
}

public enum OpenClawIDSetupStep: Equatable, Sendable {
    case signIn
    case nodeInvitation
    case nodeConnection(claw: String, connected: Bool)
    case claws(account: String, claws: [OpenClawIDSetupClaw])
    // Recovery secrets stay in the service's custody, not in view state or diagnostics.
    case recoveryKit(hostname: String, saved: Bool)
    case addDevice(claw: String, device: String, capabilities: String)
    case compareCode(claw: String, device: String, code: String, approvalURL: URL?)
    case chatAccess(claw: String, approvalURL: URL?)
    case connected(claw: String)
    case reachable(hostname: String)
    /// The OpenClaw ID sign-in window is open.
    case signingIn
    /// The owner picks how this device becomes their device.
    case chooseApproval(claw: String, device: String)
    /// A member adds this device to their account from another of their devices.
    case addMemberDevice(claw: String, device: String)
    /// The six digits are shown; the service waits for the approving device on its own, and opens
    /// its handoff only after the person confirmed the match here too. `member`: the approver is
    /// another of the member's devices, not an owner device.
    case deviceCompareCode(
        claw: String, device: String, code: String, approvalURL: URL?, confirmed: Bool, member: Bool)
    case recoveryKitEntry(claw: String)
    case ownerConnected(claw: String, device: String, approvedWith: String)
    /// A member joins with an owner's invite link.
    case inviteEntry
    /// The pasted invite is for `claw`; nothing is sent until the person asks to join.
    case memberRequest(claw: String, device: String, account: String)
    /// The request is with the claw; the service waits for an owner's approval on its own.
    case memberPending(claw: String, device: String)
    /// `role`: the invite's role; nil when another of the member's devices approved this device, which
    /// then has the account's role.
    case memberConnected(claw: String, device: String, role: String?)
    case problem(OpenClawIDSetupProblem)
}

public enum OpenClawIDSetupProblem: Equatable, Sendable {
    case clawOffline(claw: String)
    case denied(claw: String)
    case expired(claw: String)
    case kitInvalid(claw: String)
    case notInvited(account: String)
    /// The copied text is not a working invite link, or Discovery does not know its claw.
    case inviteInvalid
    /// No owner decided on this device's request within the invite's seven days.
    case inviteExpired(claw: String)
    case signInFailed
}

extension OpenClawIDSetupStep {
    /// The code is shown and the service is waiting for the owner's decision.
    public var isAwaitingApproval: Bool {
        switch self {
        case .deviceCompareCode, .memberPending: true
        default: false
        }
    }

    /// The join finished; completing it (primary connection, dashboard) may need a retry.
    public var isJoined: Bool {
        switch self {
        case .ownerConnected, .memberConnected: true
        default: false
        }
    }
}

public struct UnavailableOpenClawIDSetupService: OpenClawIDSetupService {
    public init() {}

    public var unavailableReason: String? {
        "Native OpenClaw ID setup is not available in this build. You can continue without it."
    }

    public func start(_: OpenClawIDSetupIntent) async throws -> OpenClawIDSetupStep {
        throw CocoaError(.featureUnsupported)
    }

    public func perform(_: OpenClawIDSetupAction) async throws -> OpenClawIDSetupStep {
        throw CocoaError(.featureUnsupported)
    }

    public func cancel() {}
}

@MainActor
@Observable
public final class OpenClawIDSetupModel {
    public private(set) var step: OpenClawIDSetupStep = .signIn
    public private(set) var busy = false
    public private(set) var error: String?
    public let unavailableReason: String?
    public let accountUnavailableReason: String?
    @ObservationIgnored private let service: any OpenClawIDSetupService
    @ObservationIgnored private let onNodeConnected: (String) -> Void
    @ObservationIgnored private let onJoined: (String) throws -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var wait: Task<Void, Never>?

    /// `onJoined` makes the claw this app's Gateway; it runs when an owner or member join finishes.
    public init(
        service: any OpenClawIDSetupService,
        onNodeConnected: @escaping (String) -> Void = { _ in },
        onJoined: @escaping (String) throws -> Void)
    {
        self.service = service
        self.onNodeConnected = onNodeConnected
        self.onJoined = onJoined
        self.unavailableReason = service.unavailableReason
        self.accountUnavailableReason = service.accountUnavailableReason
    }

    @discardableResult
    public func begin(_ intent: OpenClawIDSetupIntent) -> Task<Void, Never>? {
        self.cancel()
        self.step = intent == .joinNode ? .nodeInvitation : .signIn
        guard self.unavailableReason == nil else { return nil }
        return self.run { try await self.service.start(intent) }
    }

    @discardableResult
    public func perform(_ action: OpenClawIDSetupAction) -> Task<Void, Never>? {
        guard !self.busy, self.unavailableReason == nil else { return nil }
        self.wait?.cancel()
        self.wait = nil
        switch action {
        case .signIn, .switchAccount: self.step = .signingIn
        default: break
        }
        if case .retry = action, self.step.isJoined {
            return self.run { self.step }
        }
        return self.run { try await self.service.perform(action) }
    }

    public func cancel() {
        self.task?.cancel()
        self.task = nil
        self.wait?.cancel()
        self.wait = nil
        self.service.cancel()
        self.busy = false
        self.error = nil
        self.step = .signIn
    }

    private func run(_ operation: @escaping @MainActor () async throws -> OpenClawIDSetupStep)
        -> Task<Void, Never>
    {
        self.busy = true
        self.error = nil
        let task = Task { @MainActor in
            do {
                let step = try await operation()
                guard !Task.isCancelled else { return }
                try self.show(step)
            } catch {
                guard !Task.isCancelled else { return }
                // Service errors can carry sensitive response bodies; do not render them verbatim.
                self.error = "Setup did not finish. Try again or continue without OpenClaw ID."
            }
            self.busy = false
        }
        self.task = task
        return task
    }

    private func show(_ step: OpenClawIDSetupStep) throws {
        self.step = step
        switch step {
        case let .nodeConnection(claw, true): self.onNodeConnected(claw)
        case let .ownerConnected(claw, _, _), let .memberConnected(claw, _, _): try self.onJoined(claw)
        case .deviceCompareCode, .memberPending: self.awaitApproval()
        default: break
        }
    }

    /// Waits for the approving device or owner without blocking the sheet, so the person can still
    /// switch to the recovery kit or cancel a member request. Any other action cancels the wait.
    private func awaitApproval() {
        self.wait = Task { @MainActor in
            do {
                let step = try await self.service.perform(.checkApproval)
                guard !Task.isCancelled else { return }
                self.wait = nil
                try self.show(step)
            } catch {
                guard !Task.isCancelled else { return }
                self.wait = nil
                self.error = "Setup did not finish. Try again or continue without OpenClaw ID."
            }
        }
    }
}
