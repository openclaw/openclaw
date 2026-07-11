import Foundation
import Observation
import OpenClawChatUI
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol

/// Structured "Connect your AI" onboarding step.
///
/// Drives the gateway's `crestodian.setup.detect` / `crestodian.setup.activate`
/// RPCs: detect reusable AI access (Claude Code, Codex, Gemini logins, API
/// keys), live-test candidates in the detected order, and automatically fall
/// through when one fails. Config is only written server-side after a
/// candidate actually answered, so this page can never strand the user with a
/// broken model.
@MainActor
@Observable
final class OnboardingAISetupModel {
    /// Device-code providers advertise windows up to 15 minutes. Keep transport
    /// alive long enough for approval plus the post-login inference probe.
    static let providerAuthRequestTimeoutMs: Double = 1_200_000

    struct Candidate: Identifiable, Equatable {
        let kind: String
        let label: String
        let detail: String
        let modelRef: String
        let credentials: Bool?

        var id: String {
            kind
        }
    }

    enum CandidateStatus: Equatable {
        case untried
        case testing
        case failed(Failure)
        case connected
    }

    struct Failure: Equatable {
        let summary: String
        let detail: String?

        var copyText: String {
            detail ?? summary
        }
    }

    enum Phase: Equatable {
        case idle
        case detecting
        case ready
        case testing
        case connected
    }

    enum PendingVerificationOutcome: Equatable {
        case connected
        case freshSetupAllowed
        case notConnected
        case superseded
    }

    struct ManualProvider: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
    }

    struct AuthOption: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
        let groupLabel: String?
        let kind: String
        let featured: Bool
    }

    private(set) var phase: Phase = .idle {
        didSet {
            // Close-guard: quitting mid-test is confirmable, not silent.
            OnboardingController.shared.busyReason = if phase == .testing {
                "OpenClaw is testing your AI connection."
            } else if activeAuthOption != nil {
                "OpenClaw is completing provider sign-in."
            } else {
                nil
            }
        }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var authOptions: [AuthOption] = []
    private(set) var activeAuthOption: AuthOption?
    private(set) var authStep: WizardStep?
    private(set) var authError: Failure?
    private(set) var authBusy = false {
        didSet {
            if activeAuthOption != nil {
                OnboardingController.shared.busyReason = "OpenClaw is completing provider sign-in."
            } else if phase != .testing {
                OnboardingController.shared.busyReason = nil
            }
        }
    }

    var authText = ""
    var authSelection = 0
    var authConfirmation = true
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var connectedModelRef: String?
    private(set) var connectedLatencyMs: Int?
    private(set) var connectedSetupLines: [String] = []
    private(set) var detectError: Failure?
    private(set) var pendingActivationVerification = false
    private(set) var waitingForPendingActivationDeadline = false
    private(set) var configuredGatewayProbeUnavailable = false
    /// Set once every detected candidate failed; opens the manual key form.
    private(set) var exhaustedAutoCandidates = false

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false
    private(set) var manualError: Failure?
    var showManualEntry = false

    var selectedManualProvider: ManualProvider? {
        manualProviders.first { $0.id == self.manualProviderID }
    }

    var connected: Bool {
        phase == .connected
    }

    var isBusy: Bool {
        phase == .detecting || phase == .testing || manualTesting || authBusy ||
            pendingActivationVerification
    }

    /// Once setup starts changing inference, its successful result belongs to
    /// Crestodian rather than the existing-Gateway onboarding bypass.
    var ownsInferenceTransition: Bool {
        (phase == .detecting && !configuredGatewayProbeUnavailable) ||
            phase == .testing || manualTesting || authBusy || connected ||
            pendingActivationVerification
    }

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?
    /// Called whenever setup enters the read-only wait for an ambiguous
    /// activation lease. The view owns the route-bound, coalesced timer.
    var onPendingActivationDeadline: ((Date, String) -> Void)?

    private let gateway: GatewayConnection
    private let defaults: UserDefaults
    private let routeIdentityProvider: @MainActor () -> String?
    private var started = false
    private var attemptToken = UUID()
    @ObservationIgnored private var pendingVerification: PendingVerification?
    @ObservationIgnored private var pendingActivationOwner: OnboardingCrestodianResumeStore.ActivationOwner?
    @ObservationIgnored private var completedHandoff: CompletedHandoff?
    @ObservationIgnored private var pendingActivationRequiresFreshActivation = false
    @ObservationIgnored private var serverLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var lastDetectedActivationState: PersistedActivationState?
    @ObservationIgnored private var authSessionID: String?
    @ObservationIgnored private var authAttemptID = UUID()
    /// Only a just-completed provider flow may trust setupComplete without re-probing.
    @ObservationIgnored private var providerAuthReconciliationPending = false

    private struct PersistedActivationState: Equatable {
        let setupComplete: Bool
        let configuredModel: String?
    }

    private struct AttemptContext: Equatable {
        let token: UUID
        let routeIdentity: String
    }

    private struct PendingVerification {
        let context: AttemptContext
        let task: Task<PendingVerificationOutcome, Never>
    }

    private struct CompletedHandoff {
        let routeIdentity: String
        let activationOwner: OnboardingCrestodianResumeStore.ActivationOwner?
    }

    init(
        gateway: GatewayConnection = .shared,
        defaults: UserDefaults = .standard,
        routeIdentityProvider: @escaping @MainActor () -> String? = {
            OnboardingCrestodianResumeStore.selectedRouteIdentity()
        }
    ) {
        self.gateway = gateway
        self.defaults = defaults
        self.routeIdentityProvider = routeIdentityProvider
    }

    private struct DetectResult: Decodable {
        struct DetectedCandidate: Decodable {
            let kind: String
            let label: String
            let detail: String
            let modelRef: String
            let credentials: Bool?
        }

        let candidates: [DetectedCandidate]
        let manualProviders: [ManualProvider]?
        let authOptions: [AuthOption]?
        let configuredModel: String?
        let setupComplete: Bool?

        var persistedActivationState: PersistedActivationState? {
            setupComplete.map {
                PersistedActivationState(
                    setupComplete: $0,
                    configuredModel: self.configuredModel
                )
            }
        }
    }

    struct ActivateResult: Decodable {
        let ok: Bool
        let modelRef: String?
        let latencyMs: Double?
        let lines: [String]?
        let status: String?
        let error: String?
    }

    func startIfNeeded() {
        if waitingForPendingActivationDeadline {
            resetForGatewayChange(clearPendingHandoff: false)
        }
        guard !started else { return }
        configuredGatewayProbeUnavailable = false
        started = true
        phase = .detecting
        scheduleDetection()
    }

    func retryFromScratch() {
        // The configured-Gateway preflight has its own read-only retry. Never
        // turn an unavailable agents.list response into setup mutation.
        guard !configuredGatewayProbeUnavailable else { return }
        guard !waitingForPendingActivationDeadline else { return }
        if pendingActivationVerification {
            Task { await self.verifyPendingConfiguredInference() }
            return
        }
        resetForGatewayChange()
        started = true
        phase = .detecting
        scheduleDetection()
    }

    func showConfiguredGatewayProbeUnavailable() {
        guard !ownsInferenceTransition ||
            configuredGatewayProbeUnavailable ||
            waitingForPendingActivationDeadline
        else { return }
        // Retire stale candidates and `started` state. A later successful
        // missing-model probe must be able to run a fresh detect/activate flow.
        resetForGatewayChange(clearPendingHandoff: false)
        configuredGatewayProbeUnavailable = true
        phase = .ready
        detectError = Failure(
            summary: "The Gateway did not answer the inference check. Nothing was changed.",
            detail: nil
        )
    }

    func beginConfiguredGatewayProbeRetry() {
        guard configuredGatewayProbeUnavailable else { return }
        phase = .detecting
        detectError = nil
    }

    func waitForPendingActivationDeadline() {
        guard !connected,
              phase != .testing,
              !manualTesting,
              !pendingActivationVerification,
              let routeIdentity = routeIdentityProvider(),
              let deadline = activePendingActivationDeadline(for: routeIdentity)
        else { return }
        if !waitingForPendingActivationDeadline {
            resetForGatewayChange(clearPendingHandoff: false)
        }
        beginPendingActivationDeadlineWait(
            deadline: deadline,
            routeIdentity: routeIdentity
        )
    }

    /// Restore only the pending handoff state. A configured model label is not
    /// proof that the ambiguous activation completed or that inference works.
    func resumeConfiguredInference(modelRef: String) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return }
        if waitingForPendingActivationDeadline {
            resetForGatewayChange(clearPendingHandoff: false)
        }
        // Reconnects and page changes can discover the same pending handoff
        // repeatedly. Keep the first attempt and let every caller await it.
        guard !ownsInferenceTransition else { return }
        let routeIdentity = routeIdentityProvider()
        let pendingState = OnboardingCrestodianResumeStore.pendingState(
            for: routeIdentity,
            defaults: defaults
        )
        let inMemoryOwner = pendingActivationOwner
        let restoredOwner = OnboardingCrestodianResumeStore.activationOwner(
            for: routeIdentity,
            defaults: defaults
        )
        let activationOwner = inMemoryOwner ?? restoredOwner
        // A completed receipt may resume only after live inference and an exact
        // owner check. Other relaunched states must repeat activation because a
        // model label alone does not prove which attempt committed it.
        let requiresFreshActivation = inMemoryOwner != nil || pendingState != .none
        resetForGatewayChange(clearPendingHandoff: false)
        // resetForGatewayChange retires the async attempt but the route-owned
        // durable receipt above must survive into this reconciliation attempt.
        pendingActivationOwner = activationOwner
        pendingActivationRequiresFreshActivation = requiresFreshActivation
        started = true
        pendingActivationVerification = true
        phase = .detecting
    }

    /// Reconcile an ambiguous activation on the same Gateway route. A live turn
    /// is necessary, but only a matching durable completion receipt may hand off;
    /// otherwise setup repeats a fresh activate round-trip.
    @discardableResult
    func verifyPendingConfiguredInference() async -> PendingVerificationOutcome {
        guard pendingActivationVerification,
              let context = captureAttemptContext()
        else { return .superseded }
        if let pendingVerification, pendingVerification.context == context {
            let outcome = await pendingVerification.task.value
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            return outcome
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return PendingVerificationOutcome.superseded }
            return await self.performPendingConfiguredInferenceVerification(context: context)
        }
        pendingVerification = PendingVerification(context: context, task: task)
        let outcome = await task.value
        if pendingVerification?.context == context {
            pendingVerification = nil
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
        if outcome == .freshSetupAllowed, isCurrentAttempt(context) {
            resetForGatewayChange(clearPendingHandoff: false)
            startIfNeeded()
        }
        return outcome
    }

    private func performPendingConfiguredInferenceVerification(
        context: AttemptContext
    ) async -> PendingVerificationOutcome {
        guard pendingActivationVerification, isCurrentAttempt(context), !Task.isCancelled else {
            return .superseded
        }
        phase = .detecting
        detectError = nil
        let lease: GatewayConnection.ServerLease
        do {
            lease = try await gateway.acquireServerLease()
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            phase = .ready
            detectError = Self.transportFailure(
                "The selected Gateway changed before inference could be verified. Try again."
            )
            return pendingVerificationFailureOutcome(context: context)
        }
        guard isCurrentAttempt(context),
              !Task.isCancelled,
              await gateway.isCurrentServerLease(lease)
        else { return .superseded }
        if let activationOwner = pendingActivationOwner {
            guard let currentFingerprint = await gateway.activationOwnershipFingerprint(
                ifCurrentServerLease: lease
            )
            else {
                phase = .ready
                detectError = Self.transportFailure(
                    "Secure storage is unavailable, so OpenClaw cannot verify which Gateway completed AI setup."
                )
                return .notConnected
            }
            guard activationOwner.routeFingerprint == currentFingerprint else {
                switch OnboardingCrestodianResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: defaults
                ) {
                case let .activating(deadline), let .verified(deadline):
                    // Replacement auth cannot verify this owner, but the old
                    // activation may still mutate the same route. Keep its lease.
                    pendingActivationVerification = false
                    beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity
                    )
                    return .notConnected
                case .activationExpired, .completed, .none:
                    // No live mutation remains to overlap. Retire only this
                    // owner, then let the replacement credentials start fresh.
                    OnboardingCrestodianResumeStore.clear(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: activationOwner,
                        defaults: defaults
                    )
                    pendingActivationVerification = false
                    phase = .ready
                    detectError = Self.transportFailure(
                        "The Gateway authentication changed while AI setup was finishing. Testing it again."
                    )
                    return .freshSetupAllowed
                }
            }
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.verify",
                params: [:],
                timeoutMs: 150_000,
                ifCurrentServerLease: lease
            )
            guard await gateway.isCurrentServerLease(lease),
                  isCurrentAttempt(context),
                  !Task.isCancelled
            else { return .superseded }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok, let modelRef = result.modelRef {
                let pendingState = OnboardingCrestodianResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: defaults
                )
                switch pendingState {
                case let .activating(deadline), let .verified(deadline):
                    // This proves inference works, but not that the dropped
                    // activation stopped mutating. Preserve its deadline.
                    OnboardingCrestodianResumeStore.markVerified(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: pendingActivationOwner,
                        defaults: defaults
                    )
                    pendingActivationVerification = false
                    detectError = nil
                    beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity
                    )
                    return .notConnected
                case .activationExpired, .none:
                    if pendingActivationRequiresFreshActivation {
                        pendingActivationVerification = false
                        clearPendingHandoff(ifOwnedBy: context)
                        return .freshSetupAllowed
                    }
                case .completed:
                    finishConnected(
                        kind: "existing-model",
                        result: result,
                        activationOwner: pendingActivationOwner,
                        requireExistingReceipt: true
                    )
                    if connected {
                        return .connected
                    }
                    // The receipt owner changed while verification was in flight.
                    // Adopt it only for a fresh verification; this result cannot attest it.
                    retainCompletedReceiptForRetry(context: context)
                    return .notConnected
                }
                acceptVerifiedPendingInference(
                    modelRef: modelRef,
                    latencyMs: result.latencyMs
                )
                return connected ? .connected : .superseded
            }
            phase = .ready
            detectError = Self.failure(
                label: "Configured AI",
                status: result.status,
                error: result.error
            )
            return pendingVerificationFailureOutcome(context: context)
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            // A failed read-only verification never proves activation failed.
            // Keep the marker and let Try again repeat this same verification.
            phase = .ready
            detectError = Self.transportFailure(error.localizedDescription)
            return pendingVerificationFailureOutcome(context: context)
        }
    }

    private func pendingVerificationFailureOutcome(
        context: AttemptContext
    ) -> PendingVerificationOutcome {
        switch OnboardingCrestodianResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: defaults
        ) {
        case let .activating(deadline), let .verified(deadline):
            // The dropped activation may still be writing config or credentials.
            // Verification may repeat, but mutation stays blocked until its lease ends.
            if let activationOwner = pendingActivationOwner,
               !OnboardingCrestodianResumeStore.isOwned(
                   by: activationOwner,
                   for: context.routeIdentity,
                   defaults: defaults
               )
            {
                pendingActivationVerification = false
                beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity
                )
                return .notConnected
            }
            pendingActivationVerification = true
            return .notConnected
        case .completed:
            // Completion is durable proof that activation returned success. A
            // read-only transport failure cannot authorize replacement setup.
            retainCompletedReceiptForRetry(context: context)
            return .notConnected
        case .activationExpired, .none:
            pendingActivationVerification = false
            clearPendingHandoff(ifOwnedBy: context)
            return .freshSetupAllowed
        }
    }

    private func retainCompletedReceiptForRetry(context: AttemptContext) {
        pendingActivationOwner = OnboardingCrestodianResumeStore.activationOwner(
            for: context.routeIdentity,
            defaults: defaults
        )
        pendingActivationRequiresFreshActivation = true
        pendingActivationVerification = true
    }

    private func activePendingActivationDeadline(for routeIdentity: String) -> Date? {
        switch OnboardingCrestodianResumeStore.pendingState(
            for: routeIdentity,
            defaults: defaults
        ) {
        case let .activating(deadline), let .verified(deadline):
            deadline
        case .activationExpired, .completed, .none:
            nil
        }
    }

    private func beginPendingActivationDeadlineWait(
        deadline: Date,
        routeIdentity: String
    ) {
        waitingForPendingActivationDeadline = true
        phase = .detecting
        onPendingActivationDeadline?(deadline, routeIdentity)
    }

    private func retainAmbiguousActivation(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner,
        activationDeadline: Date
    ) {
        guard isCurrentAttempt(context) else { return }
        pendingActivationVerification = true
        switch OnboardingCrestodianResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: defaults
        ) {
        case let .activating(deadline), let .verified(deadline):
            guard OnboardingCrestodianResumeStore.isOwned(
                by: activationOwner,
                for: context.routeIdentity,
                defaults: defaults
            )
            else {
                // Another process replaced this lease. Never let our result
                // complete or clear the newer activation.
                pendingActivationVerification = false
                beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity
                )
                return
            }
            beginPendingActivationDeadlineWait(
                deadline: deadline,
                routeIdentity: context.routeIdentity
            )
        case .none:
            // A concurrent read-only probe can clear the marker while the
            // dispatched handler is still returning. Restore route ownership
            // before probing so failure or relaunch cannot start a duplicate.
            OnboardingCrestodianResumeStore.restorePending(
                routeIdentity: context.routeIdentity,
                activationOwner: activationOwner,
                deadline: activationDeadline,
                defaults: defaults
            )
            beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity
            )
        case .activationExpired, .completed:
            // The marker no longer blocks mutation, but the dispatched handler
            // may still commit. Probe immediately so only observed Gateway
            // state can decide when a fresh activation is safe.
            beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity
            )
        }
    }

    /// Complete a receipt-backed restored handoff after route-bound live inference.
    func acceptVerifiedPendingInference(modelRef: String, latencyMs: Double? = nil) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pendingActivationVerification, !model.isEmpty else { return }
        guard pendingActivationOwner == nil else { return }
        finishConnected(
            kind: "existing-model",
            result: ActivateResult(
                ok: true,
                modelRef: model,
                latencyMs: latencyMs,
                lines: nil,
                status: nil,
                error: nil
            ),
            activationOwner: pendingActivationOwner
        )
    }

    /// Clear only the completed receipt created by this setup attempt.
    /// A replacement activation on the same route retains its own receipt.
    func clearCompletedHandoffIfOwned() {
        guard let completedHandoff else { return }
        OnboardingCrestodianResumeStore.clear(
            ifOwnedBy: completedHandoff.routeIdentity,
            activationOwner: completedHandoff.activationOwner,
            defaults: defaults
        )
        self.completedHandoff = nil
    }

    /// Cancel route-bound work and discard results that belong to the previous Gateway.
    func resetForGatewayChange(clearPendingHandoff: Bool = true) {
        let authSessionToCancel = authSessionID
        let authServerLease = serverLease
        if clearPendingHandoff, let routeIdentity = routeIdentityProvider() {
            OnboardingCrestodianResumeStore.clear(
                ifOwnedBy: routeIdentity,
                activationOwner: pendingActivationOwner,
                defaults: defaults
            )
        }
        attemptToken = UUID()
        pendingVerification?.task.cancel()
        pendingVerification = nil
        pendingActivationOwner = nil
        completedHandoff = nil
        pendingActivationRequiresFreshActivation = false
        lastDetectedActivationState = nil
        started = false
        phase = .idle
        candidates = []
        manualProviders = []
        authOptions = []
        activeAuthOption = nil
        authStep = nil
        authError = nil
        authBusy = false
        authText = ""
        authSessionID = nil
        authAttemptID = UUID()
        providerAuthReconciliationPending = false
        providerCatalogLoaded = false
        providerCatalogError = nil
        statuses = [:]
        selectedKind = nil
        connectedModelRef = nil
        connectedLatencyMs = nil
        connectedSetupLines = []
        detectError = nil
        pendingActivationVerification = false
        waitingForPendingActivationDeadline = false
        configuredGatewayProbeUnavailable = false
        exhaustedAutoCandidates = false
        serverLease = nil
        manualProviderID = ""
        manualKey = ""
        manualError = nil
        manualTesting = false
        showManualEntry = false
        if let authSessionToCancel, let authServerLease {
            Task {
                await self.gateway.cancelWizardSession(authSessionToCancel, on: authServerLease)
            }
        }
    }
}

extension OnboardingAISetupModel {
    func detectAndAutoConnect() async {
        guard let context = captureAttemptContext() else {
            failDetectionForMissingRoute()
            return
        }
        await detectAndAutoConnect(context: context)
    }

    private func scheduleDetection() {
        guard let context = captureAttemptContext() else {
            failDetectionForMissingRoute()
            return
        }
        Task { await self.detectAndAutoConnect(context: context) }
    }

    private func detectAndAutoConnect(context: AttemptContext) async {
        // Gateway awaits can yield to a route reset or cancellation. Revalidate
        // before every activation side effect so stale attempts cannot hand off.
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        phase = .detecting
        detectError = nil
        providerCatalogError = nil
        do {
            let lease = try await gateway.acquireServerLease()
            guard isCurrentAttempt(context), !Task.isCancelled else { return }
            let data = try await gateway.request(
                method: "crestodian.setup.detect",
                params: [:],
                timeoutMs: 20000,
                ifCurrentServerLease: lease
            )
            guard await gateway.isCurrentServerLease(lease),
                  isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            serverLease = lease
            lastDetectedActivationState = result.persistedActivationState
            let manualProviders = result.manualProviders ?? []
            let authOptions = result.authOptions ?? []
            self.authOptions = authOptions
            let providerAuthReconciliationPending = self.providerAuthReconciliationPending
            self.providerAuthReconciliationPending = false
            if Self.canAcceptProviderAuthReconciliation(
                pending: providerAuthReconciliationPending,
                setupComplete: result.setupComplete == true,
                configuredModel: result.configuredModel
            ),
                let configuredModel = result.configuredModel
            {
                finishConnected(
                    kind: "provider-auth",
                    result: ActivateResult(
                        ok: true,
                        modelRef: configuredModel,
                        latencyMs: nil,
                        lines: nil,
                        status: nil,
                        error: nil
                    )
                )
                return
            }
            candidates = result.candidates.map { detected in
                Candidate(
                    kind: detected.kind,
                    label: detected.label,
                    detail: detected.detail,
                    modelRef: detected.modelRef,
                    credentials: detected.credentials
                )
            }
            self.manualProviders = manualProviders
            providerCatalogLoaded = result.manualProviders != nil
            if result.manualProviders == nil {
                providerCatalogError = OnboardingAISetupError.providerCatalogUnavailable.localizedDescription
            }
            if !manualProviders.contains(where: { $0.id == self.manualProviderID }) {
                manualProviderID = manualProviders.first?.id ?? ""
            }
            for candidate in candidates {
                statuses[candidate.kind] = .untried
            }
            phase = .ready
            if let first = autoCandidateAfter(kind: nil) {
                // Candidate found: connect without asking. Switching later
                // stays one click away while the test runs server-side.
                await activate(kind: first.kind, context: context)
            } else {
                showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard isCurrentAttempt(context) else { return }
            phase = .ready
            detectError = Self.transportFailure(error.localizedDescription)
            showManualEntry = candidates.isEmpty
        }
    }

    static func canAcceptProviderAuthReconciliation(
        pending: Bool,
        setupComplete: Bool,
        configuredModel: String?
    ) -> Bool {
        pending && setupComplete && configuredModel?.isEmpty == false
    }

    private func captureAttemptContext() -> AttemptContext? {
        let identity = routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity, !identity.isEmpty else { return nil }
        return AttemptContext(token: attemptToken, routeIdentity: identity)
    }

    private func beginAttemptContext() -> AttemptContext? {
        attemptToken = UUID()
        return captureAttemptContext()
    }

    private func isCurrentAttempt(_ context: AttemptContext) -> Bool {
        context.token == attemptToken &&
            routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines) == context.routeIdentity
    }

    private func clearPendingHandoff(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner? = nil
    ) {
        guard isCurrentAttempt(context) else { return }
        OnboardingCrestodianResumeStore.clear(
            ifOwnedBy: context.routeIdentity,
            activationOwner: activationOwner ?? pendingActivationOwner,
            defaults: defaults
        )
    }

    private func failDetectionForMissingRoute() {
        phase = .ready
        detectError = Self.transportFailure(
            "No Gateway is selected. Select a Gateway, then try again."
        )
    }

    /// Transport/protocol failures deserve plain language, not RPC codes.
    static func friendlyTransportError(_ raw: String) -> String {
        if raw.localizedCaseInsensitiveContains("unknown method") {
            return "The Gateway is running an older OpenClaw version that doesn’t support " +
                "app-guided setup. Update OpenClaw on the gateway, then try again."
        }
        return raw.isEmpty
            ? "The Gateway setup request failed."
            : "The Gateway setup request failed. Show details to inspect or copy the error."
    }

    static func activationRequestTimeoutMs(for kind: String) -> Double {
        // Codex can spend 305s installing its runtime plugin before the 90s live probe.
        // Keep a bounded client deadline with room for registry refresh and finalization.
        kind == "codex-cli"
            ? OnboardingCrestodianResumeStore.maximumActivationTimeoutMs
            : 150_000
    }

    static func activationFailureIsDefinitive(_ error: Error) -> Bool {
        if let response = error as? GatewayResponseError {
            let code = response.code.uppercased()
            let message = response.message.lowercased()
            // These responses are emitted before the activation handler runs.
            // Handler failures are UNAVAILABLE and can arrive after mutation.
            return code == "UNKNOWN_METHOD" ||
                (code == "INVALID_REQUEST" &&
                    (message.contains("unknown method") ||
                        message.contains("invalid crestodian.setup.activate params")))
        }
        return error is GatewayConnectAuthError ||
            error is GatewayTLSValidationError ||
            error is OpenClawChatTransportSendError
    }

    private static func activationTransitionWasPersisted(
        expectedModel: String,
        before: PersistedActivationState?,
        after: PersistedActivationState?
    ) -> Bool {
        guard let before, let after else { return false }
        let wasAlreadyPersisted = before.setupComplete && before.configuredModel == expectedModel
        return !wasAlreadyPersisted && after.setupComplete && after.configuredModel == expectedModel
    }

    /// Candidates the automatic ladder may try: skip definitively logged-out
    /// installs and anything already attempted.
    private func autoCandidateAfter(kind: String?) -> Candidate? {
        let startIndex: Int = if let kind, let index = candidates.firstIndex(where: { $0.kind == kind }) {
            index + 1
        } else {
            0
        }
        guard startIndex <= candidates.count else { return nil }
        return candidates[startIndex...].first { candidate in
            candidate.credentials != false && self.statuses[candidate.kind] == .untried
        }
    }

    func userSelect(kind: String) {
        guard !isBusy else { return }
        guard statuses[kind] != .connected else { return }
        guard let context = beginAttemptContext() else { return }
        Task { await self.activate(kind: kind, context: context) }
    }

    static func activationParams(
        kind: String,
        modelRef: String,
        supportsExactModel: Bool
    ) -> [String: AnyCodable] {
        var params = ["kind": AnyCodable(kind)]
        if supportsExactModel {
            params["modelRef"] = AnyCodable(modelRef)
        }
        return params
    }

    func activate(kind: String) async {
        guard !pendingActivationVerification else { return }
        guard let context = captureAttemptContext() else {
            statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."
            ))
            phase = .ready
            return
        }
        await activate(kind: kind, context: context)
    }

    private func activate(kind: String, context: AttemptContext) async {
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let candidate = candidates.first(where: { $0.kind == kind }),
              let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."
            ))
            return
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        let persistedStateBeforeActivation = lastDetectedActivationState
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: kind)
        selectedKind = kind
        phase = .testing
        statuses[kind] = .testing
        guard let supportsExactModel = await gateway.supportsServerCapability(
            .crestodianSetupModelRef,
            ifCurrentServerLease: lease
        ),
            isCurrentAttempt(context),
            !Task.isCancelled
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."
            ))
            return
        }
        guard let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease
        )
        else {
            statuses[kind] = .failed(Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup."
            ))
            phase = .ready
            return
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        let params = Self.activationParams(
            kind: kind,
            modelRef: candidate.modelRef,
            supportsExactModel: supportsExactModel
        )
        let activationOwner = OnboardingCrestodianResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint
        )
        pendingActivationOwner = activationOwner
        pendingActivationRequiresFreshActivation = true
        // Activation can persist before the response reaches the app. Cover the
        // whole ambiguous window so relaunch can inspect the actual Gateway state.
        guard let activationDeadline = OnboardingCrestodianResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults
        )
        else {
            statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."
            ))
            phase = .ready
            return
        }
        guard !Task.isCancelled else {
            clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            phase = .ready
            return
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.activate",
                params: params,
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: lease
            )
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            guard isCurrentAttempt(context), !Task.isCancelled else { return }
            guard await gateway.isCurrentServerLease(lease) else {
                if result.ok,
                   OnboardingCrestodianResumeStore.markCompleted(
                       ifOwnedBy: context.routeIdentity,
                       activationOwner: activationOwner,
                       defaults: defaults
                   )
                {
                    pendingActivationVerification = true
                    phase = .detecting
                    _ = await verifyPendingConfiguredInference()
                } else {
                    pendingActivationVerification = false
                    clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."
                    ))
                }
                return
            }
            guard isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                finishConnected(kind: kind, result: result, activationOwner: activationOwner)
            } else {
                pendingActivationVerification = false
                clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                statuses[kind] = .failed(Self.failure(
                    label: candidates.first { $0.kind == kind }?.label ?? kind,
                    status: result.status,
                    error: result.error
                ))
                await tryNextAfterFailure(of: kind, context: context)
            }
        } catch {
            guard isCurrentAttempt(context) else { return }
            // Cancellation, decoding, and transport failures after dispatch are
            // ambiguous. Keep the marker; model-label detection is not proof that
            // this activation and its credential mutation completed safely.
            let failure = Self.transportFailure(error.localizedDescription)
            statuses[kind] = .failed(failure)
            if Self.activationFailureIsDefinitive(error) {
                pendingActivationVerification = false
                clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                if await gateway.isCurrentServerLease(lease) {
                    phase = .ready
                } else {
                    requireFreshDetection(after: failure)
                }
            } else {
                // A managed Gateway can restart after persisting fresh-Mac Codex setup.
                // The retired process cannot mutate further, so accept only the same
                // route/auth owner, an exact persisted transition, and a fresh live turn.
                if !Task.isCancelled,
                   await !(gateway.isCurrentServerLease(lease)),
                   await reconcileActivationAfterGatewayRestart(
                       kind: kind,
                       context: context,
                       activationOwner: activationOwner,
                       before: persistedStateBeforeActivation,
                       originalServerLease: lease
                   )
                {
                    return
                }
                // Do not start another provider while the request can still commit.
                // The route-bound deadline probe decides whether setup may resume.
                retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline
                )
            }
        }
    }

    private func reconcileActivationAfterGatewayRestart(
        kind: String,
        context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease
    ) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(30))
        var delayMs = 250
        while clock.now < deadline {
            guard isCurrentAttempt(context), !Task.isCancelled else { return false }
            let leaseTimeoutMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: 3000
            )
            guard leaseTimeoutMs > 0 else { return false }
            if let replacementLease = try? await gateway.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: Double(leaseTimeoutMs)
            ),
                await reconcilePersistedActivation(
                    kind: kind,
                    context: context,
                    activationOwner: activationOwner,
                    before: before,
                    serverLease: replacementLease,
                    timeoutMs: Self.remainingMilliseconds(
                        until: deadline,
                        clock: clock,
                        cappedAt: 10000
                    )
                )
            {
                serverLease = replacementLease
                return true
            }
            let sleepMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: delayMs
            )
            guard sleepMs > 0 else { return false }
            do {
                try await Task.sleep(nanoseconds: UInt64(sleepMs) * 1_000_000)
            } catch {
                return false
            }
            delayMs = min(delayMs * 2, 2000)
        }
        return false
    }

    private func reconcilePersistedActivation(
        kind: String,
        context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        serverLease: GatewayConnection.ServerLease,
        timeoutMs: Int
    ) async -> Bool {
        guard timeoutMs > 0,
              let expectedModel = candidates.first(where: { $0.kind == kind })?.modelRef,
              isCurrentAttempt(context),
              !Task.isCancelled,
              OnboardingCrestodianResumeStore.isOwned(
                  by: activationOwner,
                  for: context.routeIdentity,
                  defaults: defaults
              ),
              await gateway.activationOwnershipFingerprint(ifCurrentServerLease: serverLease) ==
              activationOwner.routeFingerprint
        else { return false }
        guard let detectData = try? await gateway.request(
            method: "crestodian.setup.detect",
            params: [:],
            timeoutMs: Double(timeoutMs),
            ifCurrentServerLease: serverLease
        ),
            await gateway.isCurrentServerLease(serverLease),
            isCurrentAttempt(context),
            !Task.isCancelled,
            let detection = try? JSONDecoder().decode(DetectResult.self, from: detectData),
            Self.activationTransitionWasPersisted(
                expectedModel: expectedModel,
                before: before,
                after: detection.persistedActivationState
            )
        else { return false }
        guard let verifyData = try? await gateway.request(
            method: "crestodian.setup.verify",
            params: [:],
            timeoutMs: Double(timeoutMs),
            ifCurrentServerLease: serverLease
        ),
            await gateway.isCurrentServerLease(serverLease),
            isCurrentAttempt(context),
            !Task.isCancelled,
            let result = try? JSONDecoder().decode(ActivateResult.self, from: verifyData),
            result.ok,
            result.modelRef == expectedModel
        else { return false }
        finishConnected(
            kind: kind,
            result: result,
            activationOwner: activationOwner
        )
        return connected
    }

    private static func remainingMilliseconds(
        until deadline: ContinuousClock.Instant,
        clock: ContinuousClock,
        cappedAt capMs: Int
    ) -> Int {
        let components = clock.now.duration(to: deadline).components
        let milliseconds = components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000
        return max(0, min(capMs, Int(milliseconds)))
    }
}

extension OnboardingAISetupModel {
    func startProviderAuth(_ option: AuthOption) {
        guard !isBusy, activeAuthOption == nil, let serverLease else { return }
        activeAuthOption = option
        authStep = nil
        authError = nil
        authText = ""
        authBusy = true
        providerAuthReconciliationPending = false
        let token = attemptToken
        let authAttemptID = UUID()
        let authSessionID = UUID().uuidString
        self.authAttemptID = authAttemptID
        self.authSessionID = authSessionID
        Task {
            do {
                let data = try await self.gateway.request(
                    method: "crestodian.setup.auth.start",
                    params: [
                        "sessionId": AnyCodable(authSessionID),
                        "authChoice": AnyCodable(option.id),
                    ],
                    timeoutMs: 600_000,
                    ifCurrentServerLease: serverLease
                )
                let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else {
                    // A route reset can race the start response. Cancel the
                    // decoded server session so the discarded flow cannot commit.
                    await self.gateway.cancelWizardSession(result.sessionid, on: serverLease)
                    return
                }
                guard result.sessionid == authSessionID else {
                    self.cancelProviderAuth()
                    return
                }
                if !result.done, result.step == nil, wizardStatusString(result.status) == "running" {
                    self.advanceProviderAuth(stepID: nil, value: nil)
                    return
                }
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error
                )
            } catch {
                // The Gateway session survives socket loss; cancel by its known
                // id before reporting failure so it cannot persist config later.
                let cancellation = await self.gateway.cancelWizardSession(
                    authSessionID,
                    on: serverLease
                )
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease
                   )
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    func continueProviderAuth() {
        guard let step = authStep else { return }
        let value: AnyCodable? = switch wizardStepType(step) {
        case "text": AnyCodable(authText)
        case "select": selectedAuthWizardOption?.value
        case "confirm": AnyCodable(authConfirmation)
        default: nil
        }
        advanceProviderAuth(stepID: step.id, value: value)
    }

    func cancelProviderAuth() {
        let sessionID = authSessionID
        let authServerLease = serverLease
        guard let sessionID, let authServerLease else {
            self.authAttemptID = UUID()
            providerAuthReconciliationPending = false
            clearProviderAuth()
            return
        }
        let authAttemptID = self.authAttemptID
        let token = attemptToken
        let activationState = lastDetectedActivationState
        authBusy = true
        Task {
            let cancellation = await self.gateway.cancelWizardSession(
                sessionID,
                on: authServerLease
            )
            guard authAttemptID == self.authAttemptID else { return }
            if cancellation == .absent,
               await self.reconcileProviderAuthAfterUnknownOutcome(
                   token: token,
                   before: activationState,
                   originalServerLease: authServerLease
               )
            {
                return
            }
            if cancellation != .unresolved {
                self.authAttemptID = UUID()
                self.providerAuthReconciliationPending = false
                self.clearProviderAuth()
            }
        }
    }

    var authWizardOptions: [WizardOption] {
        parseWizardOptions(authStep?.options)
    }

    var selectedAuthWizardOption: WizardOption? {
        let options = authWizardOptions
        guard options.indices.contains(authSelection) else { return options.first }
        return options[authSelection]
    }

    private func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
        guard let sessionID = authSessionID, let serverLease else { return }
        authBusy = true
        authError = nil
        var params: [String: AnyCodable] = ["sessionId": AnyCodable(sessionID)]
        if let stepID {
            var answer: [String: AnyCodable] = ["stepId": AnyCodable(stepID)]
            if let value {
                answer["value"] = value
            }
            params["answer"] = AnyCodable(answer)
        }
        let token = attemptToken
        let authAttemptID = self.authAttemptID
        Task {
            do {
                let data = try await self.gateway.request(
                    method: "wizard.next",
                    params: params,
                    timeoutMs: Self.providerAuthRequestTimeoutMs,
                    ifCurrentServerLease: serverLease
                )
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                let result = try JSONDecoder().decode(WizardNextResult.self, from: data)
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error
                )
            } catch {
                let cancellation = await self.gateway.cancelWizardSession(sessionID, on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease
                   )
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    private func applyAuthWizardResult(
        done: Bool,
        step: WizardStep?,
        status: String?,
        error: String?
    ) {
        authBusy = false
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            // Terminal sessions are removed by the Gateway. Drop the local id
            // so Cancel dismisses the preserved, copyable error immediately.
            authSessionID = nil
            authStep = nil
            authError = Self.failure(
                label: activeAuthOption?.label ?? "Provider login",
                status: "unavailable",
                error: error
            )
            return
        }
        if status == "cancelled" {
            clearProviderAuth()
            return
        }
        if done || status == "done" {
            providerAuthReconciliationPending = true
            clearProviderAuth()
            Task { await self.detectAndAutoConnect() }
            return
        }
        authStep = step
        if validationError {
            authError = Self.failure(
                label: activeAuthOption?.label ?? "Provider login",
                status: "format",
                error: error
            )
        }
        if !preserveEnteredValue {
            authText = anyCodableString(step?.initialvalue)
        }
        authConfirmation = anyCodableBool(step?.initialvalue)
        let options = parseWizardOptions(step?.options)
        authSelection = max(0, options.firstIndex {
            anyCodableEqual($0.value, step?.initialvalue)
        } ?? 0)
    }

    private func reconcileProviderAuthAfterUnknownOutcome(
        token: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease
    ) async -> Bool {
        guard let before else { return false }
        let lease: GatewayConnection.ServerLease
        if await gateway.isCurrentServerLease(originalServerLease) {
            lease = originalServerLease
        } else {
            guard let replacement = try? await gateway.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: 5000
            )
            else { return false }
            lease = replacement
        }
        guard let data = try? await gateway.request(
            method: "crestodian.setup.detect",
            params: [:],
            timeoutMs: 10000,
            ifCurrentServerLease: lease
        ),
            token == attemptToken,
            let result = try? JSONDecoder().decode(DetectResult.self, from: data),
            let configuredModel = result.configuredModel,
            Self.activationTransitionWasPersisted(
                expectedModel: configuredModel,
                before: before,
                after: result.persistedActivationState
            )
        else { return false }
        serverLease = lease
        clearProviderAuth()
        finishConnected(
            kind: "provider-auth",
            result: ActivateResult(
                ok: true,
                modelRef: configuredModel,
                latencyMs: nil,
                lines: nil,
                status: nil,
                error: nil
            )
        )
        return true
    }

    private func clearProviderAuth() {
        activeAuthOption = nil
        authSessionID = nil
        authStep = nil
        authError = nil
        authBusy = false
        authText = ""
    }

    #if DEBUG
        func _test_setProviderAuth(option: AuthOption, sessionID: String) {
            activeAuthOption = option
            authSessionID = sessionID
            authBusy = true
        }

        func _test_applyAuthWizardResult(done: Bool, status: String?, error: String?) {
            applyAuthWizardResult(done: done, step: nil, status: status, error: error)
        }

        var _test_authSessionID: String? {
            authSessionID
        }
    #endif
}

extension OnboardingAISetupModel {
    func submitManualKey() {
        let key = manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider, !key.isEmpty, !self.isBusy else { return }
        guard let context = beginAttemptContext() else {
            manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."
            )
            return
        }
        manualError = nil
        manualTesting = true
        Task { await self.submitManualKey(key: key, provider: provider, context: context) }
    }

    private func submitManualKey(
        key: String,
        provider: ManualProvider,
        context: AttemptContext
    ) async {
        defer {
            if self.isCurrentAttempt(context) {
                self.manualTesting = false
            }
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            let failure = Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."
            )
            manualError = failure
            requireFreshDetection(after: failure)
            return
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease
        )
        else {
            manualError = Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup."
            )
            return
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: "api-key")
        let activationOwner = OnboardingCrestodianResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint
        )
        pendingActivationOwner = activationOwner
        pendingActivationRequiresFreshActivation = true
        // Manual activation has the same persist-before-response ambiguity as
        // detected candidates, so relaunch must inspect exact Gateway truth.
        guard let activationDeadline = OnboardingCrestodianResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults
        )
        else {
            manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."
            )
            return
        }
        guard !Task.isCancelled else {
            clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            return
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.activate",
                params: [
                    "kind": AnyCodable("api-key"),
                    "authChoice": AnyCodable(provider.id),
                    "apiKey": AnyCodable(key),
                ],
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: lease
            )
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            guard isCurrentAttempt(context), !Task.isCancelled else { return }
            guard await gateway.isCurrentServerLease(lease) else {
                if result.ok,
                   OnboardingCrestodianResumeStore.markCompleted(
                       ifOwnedBy: context.routeIdentity,
                       activationOwner: activationOwner,
                       defaults: defaults
                   )
                {
                    pendingActivationVerification = true
                    phase = .detecting
                    _ = await verifyPendingConfiguredInference()
                } else {
                    pendingActivationVerification = false
                    clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."
                    ))
                }
                return
            }
            guard isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                manualKey = ""
                finishConnected(
                    kind: "api-key",
                    result: result,
                    activationOwner: activationOwner
                )
            } else {
                pendingActivationVerification = false
                clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                manualError = Self.failure(
                    label: provider.label,
                    status: result.status,
                    error: result.error
                )
            }
        } catch {
            guard isCurrentAttempt(context) else { return }
            // A cancellation after request dispatch is ambiguous; keep the
            // pending marker so relaunch reconciles against this exact route.
            let failure = Self.transportFailure(error.localizedDescription)
            manualError = failure
            if Self.activationFailureIsDefinitive(error) {
                pendingActivationVerification = false
                clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                if await !(gateway.isCurrentServerLease(lease)) {
                    requireFreshDetection(after: failure)
                }
            } else {
                retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline
                )
            }
        }
    }

    /// A retired socket invalidates every candidate and provider record learned
    /// from that server generation. Preserve the error, but require a fresh
    /// detection lease before the user can dispatch another setup mutation.
    func requireFreshDetection(after failure: Failure) {
        resetForGatewayChange()
        phase = .ready
        detectError = failure
    }

    private func finishConnected(
        kind: String,
        result: ActivateResult,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner? = nil,
        requireExistingReceipt: Bool = false
    ) {
        let routeIdentity = routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        let completedReceipt = OnboardingCrestodianResumeStore.markCompleted(
            ifOwnedBy: routeIdentity,
            activationOwner: activationOwner,
            defaults: defaults
        )
        if activationOwner != nil || requireExistingReceipt {
            guard completedReceipt else {
                pendingActivationVerification = false
                statuses[kind] = .failed(Self.transportFailure(
                    "Another AI setup attempt replaced this activation. Waiting for its result."
                ))
                phase = .ready
                return
            }
        }
        pendingActivationVerification = false
        waitingForPendingActivationDeadline = false
        statuses[kind] = .connected
        selectedKind = kind
        connectedModelRef = result.modelRef
        connectedLatencyMs = result.latencyMs.map { Int($0.rounded()) }
        connectedSetupLines = Self.normalizedSetupLines(result.lines)
        phase = .connected
        pendingActivationOwner = activationOwner
        completedHandoff = completedReceipt ? routeIdentity.flatMap { routeIdentity in
            routeIdentity.isEmpty ? nil : CompletedHandoff(
                routeIdentity: routeIdentity,
                activationOwner: activationOwner
            )
        } : nil
        pendingActivationRequiresFreshActivation = false
        onConnected?()
    }

    static func normalizedSetupLines(_ lines: [String]?) -> [String] {
        (lines ?? []).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    private func tryNextAfterFailure(of kind: String, context: AttemptContext) async {
        guard isCurrentAttempt(context), !Task.isCancelled else { return }
        if let next = autoCandidateAfter(kind: kind) {
            await activate(kind: next.kind, context: context)
            return
        }
        phase = .ready
        exhaustedAutoCandidates = true
        showManualEntry = true
    }

    /// Keep the exact Gateway-sanitized error available behind the friendly
    /// summary so users can copy it into support or diagnostics.
    static func failure(label: String, status: String?, error: String?) -> Failure {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: friendlyFailure(label: label, status: status, error: detail),
            detail: detail?.isEmpty == false ? detail : nil
        )
    }

    static func transportFailure(_ raw: String) -> Failure {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: friendlyTransportError(detail),
            detail: detail.isEmpty ? nil : detail
        )
    }

    /// One friendly sentence per failure bucket.
    static func friendlyFailure(label: String, status: String?, error: String?) -> String {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch status {
        case "auth":
            return "\(label) is installed, but the login didn’t work. Sign in again, then retry."
        case "billing":
            return "\(label) responded, but the account has a billing problem."
        case "rate_limit":
            return "\(label) is temporarily rate-limited. Try again in a moment."
        case "timeout":
            return "\(label) didn’t answer in time."
        case "format", "unavailable":
            return detail.isEmpty
                ? "\(label) couldn’t complete the test."
                : "\(label) couldn’t complete the test. Show details to inspect or copy the error."
        default:
            return detail.isEmpty
                ? "\(label) couldn’t complete the test."
                : "\(label) couldn’t complete the test. Show details to inspect or copy the error."
        }
    }

    var connectedSummary: String {
        guard let modelRef = connectedModelRef else { return "Your AI is connected." }
        let label = candidates.first { $0.kind == self.selectedKind }?.label ??
            (selectedKind == "api-key" ? selectedManualProvider?.label : nil)
        let via = label.map { " via \($0)" } ?? ""
        if let latency = connectedLatencyMs {
            let seconds = Double(latency) / 1000
            return "\(modelRef)\(via) — replied in \(String(format: "%.1f", seconds))s"
        }
        return "\(modelRef)\(via)"
    }

    var connectedSetupCopyText: String {
        connectedSetupLines.joined(separator: "\n")
    }

    #if DEBUG
        func _test_setConnectedSetupLines(_ lines: [String]?) {
            connectedSetupLines = Self.normalizedSetupLines(lines)
        }
    #endif
}

private enum OnboardingAISetupError: LocalizedError {
    case providerCatalogUnavailable

    var errorDescription: String? {
        switch self {
        case .providerCatalogUnavailable:
            "The Gateway is running an older OpenClaw version that doesn’t provide the " +
                "supported provider list. Update OpenClaw on the gateway, then try again."
        }
    }
}
