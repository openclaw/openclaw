import Foundation
import Observation

/// Native enrollment owns credentials and approval checks; views receive display data only.
/// Node approval and chat access are separate grants, never one six-digit ceremony.
@MainActor
protocol OnboardingOpenClawIDService {
    var unavailableReason: String? { get }
    var accountUnavailableReason: String? { get }
    func start(_ intent: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep
    func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep
    func cancel()
}

extension OnboardingOpenClawIDService {
    var accountUnavailableReason: String? {
        self.unavailableReason
    }
}

enum OnboardingOpenClawIDIntent { case makeReachable, connect, joinNode }

enum OnboardingOpenClawIDAction {
    case signIn, selectClaw(String), saveRecoveryKit, confirmRecoveryKit, requestNode, checkApproval, requestChat
    case pasteNodeInvitation(discoveryOrigin: String)
    case approveFromDevice, useRecoveryKit, chooseKitFile, retry, back
    /// The typed recovery code. It is passed straight to the enrollment and not kept in view state.
    case submitRecoveryKit(String)
}

struct OnboardingClaw: Identifiable, Equatable {
    let id: String
    let name: String
    let relationship: String
    let online: Bool
}

enum OnboardingOpenClawIDStep: Equatable {
    case signIn
    case nodeInvitation
    case nodeConnection(claw: String, connected: Bool)
    case claws(account: String, claws: [OnboardingClaw])
    // Recovery secrets stay in the service's custody, not in view state or diagnostics.
    case recoveryKit(hostname: String, saved: Bool)
    case addMac(claw: String, device: String, capabilities: String)
    case compareCode(claw: String, device: String, code: String, approvalURL: URL?)
    case chatAccess(claw: String, approvalURL: URL?)
    case connected(claw: String)
    case reachable(hostname: String)
    /// The OpenClaw ID sign-in window is open.
    case signingIn
    /// The owner picks how this Mac becomes their device.
    case chooseApproval(claw: String, device: String)
    /// The six digits are shown; the service waits for the approving device on its own.
    case ownerCompareCode(claw: String, device: String, code: String, approvalURL: URL?)
    case recoveryKitEntry(claw: String)
    case ownerConnected(claw: String, device: String, approvedWith: String)
    case problem(OnboardingOpenClawIDProblem)
}

enum OnboardingOpenClawIDProblem: Equatable {
    case clawOffline(claw: String)
    case denied(claw: String)
    case expired(claw: String)
    case kitInvalid(claw: String)
    case notInvited(account: String)
    /// A claw this account joined as a member: a new Mac needs its own invite.
    case memberNeedsInvite(claw: String)
    case signInFailed
}

extension OnboardingOpenClawIDStep {
    /// The code is shown and the service is waiting for the owner's decision.
    var isAwaitingApproval: Bool {
        if case .ownerCompareCode = self { return true }
        return false
    }
}

struct UnavailableOnboardingOpenClawIDService: OnboardingOpenClawIDService {
    var unavailableReason: String? {
        "Native OpenClaw ID setup is not available in this build. You can continue without it."
    }

    func start(_: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        throw CocoaError(.featureUnsupported)
    }

    func perform(_: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        throw CocoaError(.featureUnsupported)
    }

    func cancel() {}
}

@MainActor
@Observable
final class OnboardingOpenClawIDModel {
    private(set) var step: OnboardingOpenClawIDStep = .signIn
    private(set) var busy = false
    private(set) var error: String?
    let unavailableReason: String?
    let accountUnavailableReason: String?
    @ObservationIgnored private let service: any OnboardingOpenClawIDService
    @ObservationIgnored private let onNodeConnected: (String) -> Void
    @ObservationIgnored private let onJoined: (String) -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var wait: Task<Void, Never>?

    init(
        service: any OnboardingOpenClawIDService,
        onNodeConnected: @escaping (String) -> Void = { _ in },
        onJoined: @escaping (String) -> Void = { MacOpenClawIDJoinCompletion.finish(claw: $0) })
    {
        self.service = service
        self.onNodeConnected = onNodeConnected
        self.onJoined = onJoined
        self.unavailableReason = service.unavailableReason
        self.accountUnavailableReason = service.accountUnavailableReason
    }

    @discardableResult
    func begin(_ intent: OnboardingOpenClawIDIntent) -> Task<Void, Never>? {
        self.cancel()
        self.step = intent == .joinNode ? .nodeInvitation : .signIn
        guard self.unavailableReason == nil else { return nil }
        return self.run { try await self.service.start(intent) }
    }

    @discardableResult
    func perform(_ action: OnboardingOpenClawIDAction) -> Task<Void, Never>? {
        guard !self.busy, self.unavailableReason == nil else { return nil }
        self.wait?.cancel()
        self.wait = nil
        if case .signIn = action { self.step = .signingIn }
        return self.run { try await self.service.perform(action) }
    }

    func cancel() {
        self.task?.cancel()
        self.task = nil
        self.wait?.cancel()
        self.wait = nil
        self.service.cancel()
        self.busy = false
        self.error = nil
        self.step = .signIn
    }

    private func run(_ operation: @escaping @MainActor () async throws -> OnboardingOpenClawIDStep)
        -> Task<Void, Never>
    {
        self.busy = true
        self.error = nil
        let task = Task { @MainActor in
            do {
                let step = try await operation()
                guard !Task.isCancelled else { return }
                self.show(step)
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

    private func show(_ step: OnboardingOpenClawIDStep) {
        self.step = step
        switch step {
        case let .nodeConnection(claw, true): self.onNodeConnected(claw)
        case let .ownerConnected(claw, _, _): self.onJoined(claw)
        case .ownerCompareCode: self.awaitApproval()
        default: break
        }
    }

    /// Waits for the approving device without blocking the sheet, so the person can still switch
    /// to the recovery kit. Any other action cancels the wait.
    private func awaitApproval() {
        self.wait = Task { @MainActor in
            do {
                let step = try await self.service.perform(.checkApproval)
                guard !Task.isCancelled else { return }
                self.wait = nil
                self.show(step)
            } catch {
                guard !Task.isCancelled else { return }
                self.wait = nil
                self.error = "Setup did not finish. Try again or continue without OpenClaw ID."
            }
        }
    }
}
