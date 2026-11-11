import Foundation
import Observation

/// Native enrollment owns credentials and approval checks; views receive display data only.
/// For a Mac, one compared code and one owner approval grant the node and, separately keyed,
/// chat and dashboard access. The claw records them as distinct grants.
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
    /// The pasted link or owner command, with the Advanced Discovery origin (empty: use the link's).
    case submitNodeInvitation(text: String, discoveryOrigin: String)
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
}

extension OnboardingOpenClawIDStep {
    /// The code is shown and the service is waiting for the owner's decision.
    var isAwaitingApproval: Bool {
        if case .compareCode = self { return true }
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
    /// An invitation opened through an `openclaw-node://` link, shown in the paste field.
    var pendingInvitation: String?
    @ObservationIgnored private let service: any OnboardingOpenClawIDService
    @ObservationIgnored private let onNodeConnected: (String) -> Void
    @ObservationIgnored private var task: Task<Void, Never>?

    init(
        service: any OnboardingOpenClawIDService,
        onNodeConnected: @escaping (String) -> Void = { _ in })
    {
        self.service = service
        self.onNodeConnected = onNodeConnected
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
        return self.run { try await self.service.perform(action) }
    }

    func cancel() {
        self.task?.cancel()
        self.task = nil
        self.service.cancel()
        self.busy = false
        self.error = nil
        self.step = .signIn
        self.pendingInvitation = nil
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
                self.step = step
                switch step {
                case .compareCode:
                    // The Gateway knows when the owner decides; wait for it rather than a click.
                    self.busy = false
                    self.perform(.checkApproval)
                    return
                case let .connected(claw), let .nodeConnection(claw, true):
                    self.onNodeConnected(claw)
                default:
                    break
                }
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
}
