import AppKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawIPC
import OpenClawKit
import SwiftUI

/// Structured "Connect your AI" onboarding step.
///
/// Drives the gateway's `crestodian.setup.detect` / `crestodian.setup.activate`
/// RPCs: detect reusable AI access (Claude Code and Codex logins, plus API
/// keys), live-test the best candidate, and automatically fall through to the
/// next one when a test fails. Config is only written server-side after a
/// candidate actually answered, so this page can never strand the user with a
/// broken model.
@MainActor
@Observable
final class OnboardingAISetupModel {
    struct Candidate: Identifiable, Equatable {
        let kind: String
        let label: String
        let detail: String
        let modelRef: String
        let recommended: Bool
        let credentials: Bool?

        var id: String {
            self.kind
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
            self.detail ?? self.summary
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

    private(set) var phase: Phase = .idle {
        didSet {
            // Close-guard: quitting mid-test is confirmable, not silent.
            OnboardingController.shared.busyReason = self.phase == .testing
                ? "OpenClaw is testing your AI connection."
                : nil
        }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var connectedModelRef: String?
    private(set) var connectedLatencyMs: Int?
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
        self.manualProviders.first { $0.id == self.manualProviderID }
    }

    var connected: Bool {
        self.phase == .connected
    }

    var isBusy: Bool {
        self.phase == .detecting || self.phase == .testing || self.manualTesting || self.pendingActivationVerification
    }

    /// Once setup starts changing inference, its successful result belongs to
    /// Crestodian rather than the existing-Gateway onboarding bypass.
    var ownsInferenceTransition: Bool {
        (self.phase == .detecting && !self.configuredGatewayProbeUnavailable) ||
            self.phase == .testing || self.manualTesting || self.connected || self.pendingActivationVerification
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
        })
    {
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
            let recommended: Bool
            let credentials: Bool?
        }

        let candidates: [DetectedCandidate]
        let manualProviders: [ManualProvider]?
    }

    private struct ActivateResult: Decodable {
        let ok: Bool
        let modelRef: String?
        let latencyMs: Double?
        let status: String?
        let error: String?
    }

    func startIfNeeded() {
        if self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        guard !self.started else { return }
        self.configuredGatewayProbeUnavailable = false
        self.started = true
        self.phase = .detecting
        self.scheduleDetection()
    }

    func retryFromScratch() {
        // The configured-Gateway preflight has its own read-only retry. Never
        // turn an unavailable agents.list response into setup mutation.
        guard !self.configuredGatewayProbeUnavailable else { return }
        guard !self.waitingForPendingActivationDeadline else { return }
        if self.pendingActivationVerification {
            Task { await self.verifyPendingConfiguredInference() }
            return
        }
        self.resetForGatewayChange()
        self.started = true
        self.phase = .detecting
        self.scheduleDetection()
    }

    func showConfiguredGatewayProbeUnavailable() {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayProbeUnavailable ||
            self.waitingForPendingActivationDeadline
        else { return }
        // Retire stale candidates and `started` state. A later successful
        // missing-model probe must be able to run a fresh detect/activate flow.
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.configuredGatewayProbeUnavailable = true
        self.phase = .ready
        self.detectError = Failure(
            summary: "The Gateway did not answer the inference check. Nothing was changed.",
            detail: nil)
    }

    func beginConfiguredGatewayProbeRetry() {
        guard self.configuredGatewayProbeUnavailable else { return }
        self.phase = .detecting
        self.detectError = nil
    }

    func waitForPendingActivationDeadline() {
        guard !self.connected,
              self.phase != .testing,
              !self.manualTesting,
              !self.pendingActivationVerification,
              let routeIdentity = routeIdentityProvider(),
              let deadline = activePendingActivationDeadline(for: routeIdentity)
        else { return }
        if !self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        self.beginPendingActivationDeadlineWait(
            deadline: deadline,
            routeIdentity: routeIdentity)
    }

    /// Restore only the pending handoff state. A configured model label is not
    /// proof that the ambiguous activation completed or that inference works.
    func resumeConfiguredInference(modelRef: String) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return }
        if self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        // Reconnects and page changes can discover the same pending handoff
        // repeatedly. Keep the first attempt and let every caller await it.
        guard !self.ownsInferenceTransition else { return }
        let routeIdentity = self.routeIdentityProvider()
        let pendingState = OnboardingCrestodianResumeStore.pendingState(
            for: routeIdentity,
            defaults: self.defaults)
        let inMemoryOwner = self.pendingActivationOwner
        let restoredOwner = OnboardingCrestodianResumeStore.activationOwner(
            for: routeIdentity,
            defaults: self.defaults)
        let activationOwner = inMemoryOwner ?? restoredOwner
        // A completed receipt may resume only after live inference and an exact
        // owner check. Other relaunched states must repeat activation because a
        // model label alone does not prove which attempt committed it.
        let requiresFreshActivation = inMemoryOwner != nil || pendingState != .none
        self.resetForGatewayChange(clearPendingHandoff: false)
        // resetForGatewayChange retires the async attempt but the route-owned
        // durable receipt above must survive into this reconciliation attempt.
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = requiresFreshActivation
        self.started = true
        self.pendingActivationVerification = true
        self.phase = .detecting
    }

    /// Reconcile an ambiguous activation on the same Gateway route. A live turn
    /// is necessary, but only a matching durable completion receipt may hand off;
    /// otherwise setup repeats a fresh activate round-trip.
    @discardableResult
    func verifyPendingConfiguredInference() async -> PendingVerificationOutcome {
        guard self.pendingActivationVerification,
              let context = captureAttemptContext()
        else { return .superseded }
        if let pendingVerification, pendingVerification.context == context {
            let outcome = await pendingVerification.task.value
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
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
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
        if outcome == .freshSetupAllowed, self.isCurrentAttempt(context) {
            self.resetForGatewayChange(clearPendingHandoff: false)
            self.startIfNeeded()
        }
        return outcome
    }

    private func performPendingConfiguredInferenceVerification(
        context: AttemptContext) async -> PendingVerificationOutcome
    {
        guard self.pendingActivationVerification, self.isCurrentAttempt(context), !Task.isCancelled else {
            return .superseded
        }
        self.phase = .detecting
        self.detectError = nil
        guard let route = await captureGatewayRoute(for: context) else {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            self.phase = .ready
            self.detectError = Self.transportFailure(
                "The selected Gateway changed before inference could be verified. Try again.")
            return self.pendingVerificationFailureOutcome(context: context)
        }
        if let activationOwner = pendingActivationOwner {
            guard let currentFingerprint = route.activationOwnershipFingerprint else {
                self.phase = .ready
                self.detectError = Self.transportFailure(
                    "Secure storage is unavailable, so OpenClaw cannot verify which Gateway completed AI setup.")
                return .notConnected
            }
            guard activationOwner.routeFingerprint == currentFingerprint else {
                switch OnboardingCrestodianResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: self.defaults)
                {
                case let .activating(deadline), let .verified(deadline):
                    // Replacement auth cannot verify this owner, but the old
                    // activation may still mutate the same route. Keep its lease.
                    self.pendingActivationVerification = false
                    self.beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity)
                    return .notConnected
                case .activationExpired, .completed, .none:
                    // No live mutation remains to overlap. Retire only this
                    // owner, then let the replacement credentials start fresh.
                    OnboardingCrestodianResumeStore.clear(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: activationOwner,
                        defaults: self.defaults)
                    self.pendingActivationVerification = false
                    self.phase = .ready
                    self.detectError = Self.transportFailure(
                        "The Gateway authentication changed while AI setup was finishing. Testing it again.")
                    return .freshSetupAllowed
                }
            }
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.verify",
                params: [:],
                timeoutMs: 150_000,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            let routeIsCurrent = await gateway.isCurrentRoute(route)
            guard routeIsCurrent,
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return .superseded }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok, let modelRef = result.modelRef {
                let pendingState = OnboardingCrestodianResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: self.defaults)
                switch pendingState {
                case let .activating(deadline), let .verified(deadline):
                    // This proves inference works, but not that the dropped
                    // activation stopped mutating. Preserve its deadline.
                    OnboardingCrestodianResumeStore.markVerified(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: self.pendingActivationOwner,
                        defaults: self.defaults)
                    self.pendingActivationVerification = false
                    self.detectError = nil
                    self.beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity)
                    return .notConnected
                case .activationExpired, .none:
                    if self.pendingActivationRequiresFreshActivation {
                        self.pendingActivationVerification = false
                        self.clearPendingHandoff(ifOwnedBy: context)
                        return .freshSetupAllowed
                    }
                case .completed:
                    self.finishConnected(
                        kind: "existing-model",
                        result: result,
                        activationOwner: self.pendingActivationOwner,
                        requireExistingReceipt: true)
                    if self.connected {
                        return .connected
                    }
                    // The receipt owner changed while verification was in flight.
                    // Adopt it only for a fresh verification; this result cannot attest it.
                    self.retainCompletedReceiptForRetry(context: context)
                    return .notConnected
                }
                self.acceptVerifiedPendingInference(
                    modelRef: modelRef,
                    latencyMs: result.latencyMs)
                return self.connected ? .connected : .superseded
            }
            self.phase = .ready
            self.detectError = Self.failure(
                label: "Configured AI",
                status: result.status,
                error: result.error)
            return self.pendingVerificationFailureOutcome(context: context)
        } catch {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            // A failed read-only verification never proves activation failed.
            // Keep the marker and let Try again repeat this same verification.
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            return self.pendingVerificationFailureOutcome(context: context)
        }
    }

    private func pendingVerificationFailureOutcome(
        context: AttemptContext) -> PendingVerificationOutcome
    {
        switch OnboardingCrestodianResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            // The dropped activation may still be writing config or credentials.
            // Verification may repeat, but mutation stays blocked until its lease ends.
            if let activationOwner = pendingActivationOwner,
               !OnboardingCrestodianResumeStore.isOwned(
                   by: activationOwner,
                   for: context.routeIdentity,
                   defaults: defaults)
            {
                self.pendingActivationVerification = false
                self.beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity)
                return .notConnected
            }
            self.pendingActivationVerification = true
            return .notConnected
        case .completed:
            // Completion is durable proof that activation returned success. A
            // read-only transport failure cannot authorize replacement setup.
            self.retainCompletedReceiptForRetry(context: context)
            return .notConnected
        case .activationExpired, .none:
            self.pendingActivationVerification = false
            self.clearPendingHandoff(ifOwnedBy: context)
            return .freshSetupAllowed
        }
    }

    private func retainCompletedReceiptForRetry(context: AttemptContext) {
        self.pendingActivationOwner = OnboardingCrestodianResumeStore.activationOwner(
            for: context.routeIdentity,
            defaults: self.defaults)
        self.pendingActivationRequiresFreshActivation = true
        self.pendingActivationVerification = true
    }

    private func activePendingActivationDeadline(for routeIdentity: String) -> Date? {
        switch OnboardingCrestodianResumeStore.pendingState(
            for: routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            deadline
        case .activationExpired, .completed, .none:
            nil
        }
    }

    private func beginPendingActivationDeadlineWait(
        deadline: Date,
        routeIdentity: String)
    {
        self.waitingForPendingActivationDeadline = true
        self.phase = .detecting
        self.onPendingActivationDeadline?(deadline, routeIdentity)
    }

    private func retainAmbiguousActivation(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner,
        activationDeadline: Date)
    {
        guard self.isCurrentAttempt(context) else { return }
        self.pendingActivationVerification = true
        switch OnboardingCrestodianResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            guard OnboardingCrestodianResumeStore.isOwned(
                by: activationOwner,
                for: context.routeIdentity,
                defaults: self.defaults)
            else {
                // Another process replaced this lease. Never let our result
                // complete or clear the newer activation.
                self.pendingActivationVerification = false
                self.beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity)
                return
            }
            self.beginPendingActivationDeadlineWait(
                deadline: deadline,
                routeIdentity: context.routeIdentity)
        case .none:
            // A concurrent read-only probe can clear the marker while the
            // dispatched handler is still returning. Restore route ownership
            // before probing so failure or relaunch cannot start a duplicate.
            OnboardingCrestodianResumeStore.restorePending(
                routeIdentity: context.routeIdentity,
                activationOwner: activationOwner,
                deadline: activationDeadline,
                defaults: self.defaults)
            self.beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity)
        case .activationExpired, .completed:
            // The marker no longer blocks mutation, but the dispatched handler
            // may still commit. Probe immediately so only observed Gateway
            // state can decide when a fresh activation is safe.
            self.beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity)
        }
    }

    /// Complete a receipt-backed restored handoff after route-bound live inference.
    func acceptVerifiedPendingInference(modelRef: String, latencyMs: Double? = nil) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.pendingActivationVerification, !model.isEmpty else { return }
        guard self.pendingActivationOwner == nil else { return }
        self.finishConnected(
            kind: "existing-model",
            result: ActivateResult(
                ok: true,
                modelRef: model,
                latencyMs: latencyMs,
                status: nil,
                error: nil),
            activationOwner: self.pendingActivationOwner)
    }

    /// Clear only the completed receipt created by this setup attempt.
    /// A replacement activation on the same route retains its own receipt.
    func clearCompletedHandoffIfOwned() {
        guard let completedHandoff else { return }
        OnboardingCrestodianResumeStore.clear(
            ifOwnedBy: completedHandoff.routeIdentity,
            activationOwner: completedHandoff.activationOwner,
            defaults: self.defaults)
        self.completedHandoff = nil
    }

    /// Cancel route-bound work and discard results that belong to the previous Gateway.
    func resetForGatewayChange(clearPendingHandoff: Bool = true) {
        if clearPendingHandoff, let routeIdentity = routeIdentityProvider() {
            OnboardingCrestodianResumeStore.clear(
                ifOwnedBy: routeIdentity,
                activationOwner: self.pendingActivationOwner,
                defaults: self.defaults)
        }
        self.attemptToken = UUID()
        self.pendingVerification?.task.cancel()
        self.pendingVerification = nil
        self.pendingActivationOwner = nil
        self.completedHandoff = nil
        self.pendingActivationRequiresFreshActivation = false
        self.started = false
        self.phase = .idle
        self.candidates = []
        self.manualProviders = []
        self.providerCatalogLoaded = false
        self.providerCatalogError = nil
        self.statuses = [:]
        self.selectedKind = nil
        self.connectedModelRef = nil
        self.connectedLatencyMs = nil
        self.detectError = nil
        self.pendingActivationVerification = false
        self.waitingForPendingActivationDeadline = false
        self.configuredGatewayProbeUnavailable = false
        self.exhaustedAutoCandidates = false
        self.manualProviderID = ""
        self.manualKey = ""
        self.manualError = nil
        self.manualTesting = false
        self.showManualEntry = false
    }

    func detectAndAutoConnect() async {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        await self.detectAndAutoConnect(context: context)
    }

    private func scheduleDetection() {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        Task { await self.detectAndAutoConnect(context: context) }
    }

    private func detectAndAutoConnect(context: AttemptContext) async {
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        self.phase = .detecting
        self.detectError = nil
        self.providerCatalogError = nil
        guard let route = await captureGatewayRoute(for: context) else {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            self.phase = .ready
            self.detectError = Self.transportFailure(
                "The selected Gateway is unavailable. Select it again, then retry.")
            return
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.detect",
                params: [:],
                timeoutMs: 20000,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            let routeIsCurrent = await gateway.isCurrentRoute(route)
            guard routeIsCurrent,
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            let manualProviders = result.manualProviders ?? []
            self.candidates = result.candidates.map { detected in
                Candidate(
                    kind: detected.kind,
                    label: detected.label,
                    detail: detected.detail,
                    modelRef: detected.modelRef,
                    recommended: detected.recommended,
                    credentials: detected.credentials)
            }
            self.manualProviders = manualProviders
            self.providerCatalogLoaded = result.manualProviders != nil
            if result.manualProviders == nil {
                self.providerCatalogError = OnboardingAISetupError.providerCatalogUnavailable.localizedDescription
            }
            if !manualProviders.contains(where: { $0.id == self.manualProviderID }) {
                self.manualProviderID = manualProviders.first?.id ?? ""
            }
            for candidate in self.candidates {
                self.statuses[candidate.kind] = .untried
            }
            self.phase = .ready
            if let first = autoCandidateAfter(kind: nil) {
                // Best candidate found: connect without asking. Switching later
                // stays one click away while the test runs server-side.
                await self.activate(kind: first.kind, context: context)
            } else {
                self.showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            self.showManualEntry = self.candidates.isEmpty
        }
    }

    private func captureAttemptContext() -> AttemptContext? {
        let identity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity, !identity.isEmpty else { return nil }
        return AttemptContext(token: self.attemptToken, routeIdentity: identity)
    }

    private func beginAttemptContext() -> AttemptContext? {
        self.attemptToken = UUID()
        return self.captureAttemptContext()
    }

    private func isCurrentAttempt(_ context: AttemptContext) -> Bool {
        context.token == self.attemptToken &&
            self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines) == context.routeIdentity
    }

    private func captureGatewayRoute(for context: AttemptContext) async -> GatewayConnection.Route? {
        guard self.isCurrentAttempt(context), !Task.isCancelled,
              let route = await gateway.captureRoute(),
              isCurrentAttempt(context), !Task.isCancelled
        else { return nil }
        let routeIsCurrent = await gateway.isCurrentRoute(route)
        guard routeIsCurrent,
              self.isCurrentAttempt(context),
              !Task.isCancelled
        else { return nil }
        return route
    }

    private func clearPendingHandoff(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner? = nil)
    {
        guard self.isCurrentAttempt(context) else { return }
        OnboardingCrestodianResumeStore.clear(
            ifOwnedBy: context.routeIdentity,
            activationOwner: activationOwner ?? self.pendingActivationOwner,
            defaults: self.defaults)
    }

    private func failDetectionForMissingRoute() {
        self.phase = .ready
        self.detectError = Self.transportFailure(
            "No Gateway is selected. Select a Gateway, then try again.")
    }

    /// Transport/protocol failures deserve plain language, not RPC codes.
    static func friendlyTransportError(_ raw: String) -> String {
        if raw.localizedCaseInsensitiveContains("unknown method") {
            return "The Gateway is running an older OpenClaw version that doesn’t support " +
                "app-guided setup. Update OpenClaw on the gateway, then try again."
        }
        return raw
    }

    static func activationRequestTimeoutMs(for kind: String) -> Double {
        // Codex can spend 305s installing its runtime plugin before the 90s live probe.
        // Keep a bounded client deadline with room for registry refresh and finalization.
        kind == "codex-cli" ? OnboardingCrestodianResumeStore.maximumActivationTimeoutMs : 150_000
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

    /// Candidates the automatic ladder may try: skip definitively logged-out
    /// installs and anything already attempted.
    private func autoCandidateAfter(kind: String?) -> Candidate? {
        let startIndex: Int = if let kind, let index = candidates.firstIndex(where: { $0.kind == kind }) {
            index + 1
        } else {
            0
        }
        guard startIndex <= self.candidates.count else { return nil }
        return self.candidates[startIndex...].first { candidate in
            candidate.credentials != false && self.statuses[candidate.kind] == .untried
        }
    }

    func userSelect(kind: String) {
        guard !self.isBusy else { return }
        guard self.statuses[kind] != .connected else { return }
        guard let context = beginAttemptContext() else { return }
        Task { await self.activate(kind: kind, context: context) }
    }

    func activate(kind: String) async {
        guard !self.pendingActivationVerification else { return }
        guard let context = captureAttemptContext() else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."))
            self.phase = .ready
            return
        }
        await self.activate(kind: kind, context: context)
    }

    private func activate(kind: String, context: AttemptContext) async {
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: kind)
        self.selectedKind = kind
        self.phase = .testing
        self.statuses[kind] = .testing
        guard let route = await captureGatewayRoute(for: context) else {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            self.statuses[kind] = .failed(Self.transportFailure(
                "The selected Gateway changed before the test started. Try again."))
            self.phase = .ready
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let routeFingerprint = route.activationOwnershipFingerprint else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup."))
            self.phase = .ready
            return
        }
        let activationOwner = OnboardingCrestodianResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint)
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        // Activation can persist before the response reaches the app. Cover the
        // whole ambiguous window so relaunch can inspect the actual Gateway state.
        guard let activationDeadline = OnboardingCrestodianResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults)
        else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."))
            self.phase = .ready
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            self.phase = .ready
            return
        }
        do {
            let data = try await gateway.request(
                method: "crestodian.setup.activate",
                params: ["kind": AnyCodable(kind)],
                timeoutMs: requestTimeoutMs,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            let routeIsCurrent = await gateway.isCurrentRoute(route)
            guard routeIsCurrent,
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok {
                self.finishConnected(kind: kind, result: result, activationOwner: activationOwner)
            } else {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.statuses[kind] = .failed(Self.failure(
                    label: self.candidates.first { $0.kind == kind }?.label ?? kind,
                    status: result.status,
                    error: result.error))
                await self.tryNextAfterFailure(of: kind, context: context)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // Cancellation, decoding, and transport failures after dispatch are
            // ambiguous. Keep the marker; model-label detection is not proof that
            // this activation and its credential mutation completed safely.
            self.statuses[kind] = .failed(Self.transportFailure(error.localizedDescription))
            if Self.activationFailureIsDefinitive(error) {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.phase = .ready
            } else {
                // Do not start another provider while the request can still commit.
                // The route-bound deadline probe decides whether setup may resume.
                self.retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }

    func submitManualKey() {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider, !key.isEmpty, !self.isBusy else { return }
        guard let context = beginAttemptContext() else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        self.manualError = nil
        self.manualTesting = true
        Task { await self.submitManualKey(key: key, provider: provider, context: context) }
    }

    private func submitManualKey(
        key: String,
        provider: ManualProvider,
        context: AttemptContext) async
    {
        defer {
            if self.isCurrentAttempt(context) {
                self.manualTesting = false
            }
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let route = await captureGatewayRoute(for: context) else {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            self.manualError = Self.transportFailure(
                "The selected Gateway changed before the test started. Try again.")
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let routeFingerprint = route.activationOwnershipFingerprint else {
            self.manualError = Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup.")
            return
        }
        let activationOwner = OnboardingCrestodianResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint)
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        // Manual activation has the same persist-before-response ambiguity as
        // detected candidates, so relaunch must inspect exact Gateway truth.
        guard let activationDeadline = OnboardingCrestodianResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: 150_000,
            defaults: defaults)
        else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
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
                timeoutMs: 150_000,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            let routeIsCurrent = await gateway.isCurrentRoute(route)
            guard routeIsCurrent,
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok {
                self.manualKey = ""
                self.finishConnected(
                    kind: "api-key",
                    result: result,
                    activationOwner: activationOwner)
            } else {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.manualError = Self.failure(
                    label: provider.label,
                    status: result.status,
                    error: result.error)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // A cancellation after request dispatch is ambiguous; keep the
            // pending marker so relaunch reconciles against this exact route.
            self.manualError = Self.transportFailure(error.localizedDescription)
            if Self.activationFailureIsDefinitive(error) {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            } else {
                self.retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }

    private func finishConnected(
        kind: String,
        result: ActivateResult,
        activationOwner: OnboardingCrestodianResumeStore.ActivationOwner? = nil,
        requireExistingReceipt: Bool = false)
    {
        let routeIdentity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        let completedReceipt = OnboardingCrestodianResumeStore.markCompleted(
            ifOwnedBy: routeIdentity,
            activationOwner: activationOwner,
            defaults: self.defaults)
        if activationOwner != nil || requireExistingReceipt {
            guard completedReceipt else {
                self.pendingActivationVerification = false
                self.statuses[kind] = .failed(Self.transportFailure(
                    "Another AI setup attempt replaced this activation. Waiting for its result."))
                self.phase = .ready
                return
            }
        }
        self.pendingActivationVerification = false
        self.waitingForPendingActivationDeadline = false
        self.statuses[kind] = .connected
        self.selectedKind = kind
        self.connectedModelRef = result.modelRef
        self.connectedLatencyMs = result.latencyMs.map { Int($0.rounded()) }
        self.phase = .connected
        self.pendingActivationOwner = activationOwner
        self.completedHandoff = completedReceipt ? routeIdentity.flatMap { routeIdentity in
            routeIdentity.isEmpty ? nil : CompletedHandoff(
                routeIdentity: routeIdentity,
                activationOwner: activationOwner)
        } : nil
        self.pendingActivationRequiresFreshActivation = false
        self.onConnected?()
    }

    private func tryNextAfterFailure(of kind: String, context: AttemptContext) async {
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        if let next = autoCandidateAfter(kind: kind) {
            await self.activate(kind: next.kind, context: context)
            return
        }
        self.phase = .ready
        self.exhaustedAutoCandidates = true
        self.showManualEntry = true
    }

    /// Keep the exact Gateway-sanitized error available behind the friendly
    /// summary so users can copy it into support or diagnostics.
    static func failure(label: String, status: String?, error: String?) -> Failure {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyFailure(label: label, status: status, error: detail),
            detail: detail?.isEmpty == false ? detail : nil)
    }

    static func transportFailure(_ raw: String) -> Failure {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyTransportError(detail),
            detail: detail.isEmpty ? nil : detail)
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
            return detail.isEmpty ? "\(label) couldn’t complete the test." : detail
        default:
            return detail.isEmpty ? "\(label) couldn’t complete the test." : detail
        }
    }

    var connectedSummary: String {
        guard let modelRef = connectedModelRef else { return "Your AI is connected." }
        let label = self.candidates.first { $0.kind == self.selectedKind }?.label ??
            (self.selectedKind == "api-key" ? self.selectedManualProvider?.label : nil)
        let via = label.map { " via \($0)" } ?? ""
        if let latency = connectedLatencyMs {
            let seconds = Double(latency) / 1000
            return "\(modelRef)\(via) — replied in \(String(format: "%.1f", seconds))s"
        }
        return "\(modelRef)\(via)"
    }
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

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var crestodianChat: CrestodianOnboardingChatModel
    @Binding var showCrestodianChat: Bool
    var retryConfiguredGatewayProbe: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch self.model.phase {
            case .idle, .detecting:
                self.detectingView
            default:
                self.resultsView
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: self.$showCrestodianChat) {
            self.crestodianSheet
        }
    }

    private var detectingView: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(self.model.waitingForPendingActivationDeadline
                    ? "Waiting for the previous AI test to finish…"
                    : "Looking for AI you already use…")
                    .font(.callout.weight(.semibold))
                Text(self.model.waitingForPendingActivationDeadline
                    ? "OpenClaw will check again before changing any inference settings."
                    : "Checking for Claude Code, Codex, Gemini, and saved API keys.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var resultsView: some View {
        if self.model.connected {
            self.connectedBanner
        }

        if !self.model.candidates.isEmpty {
            VStack(spacing: 8) {
                ForEach(self.model.candidates) { candidate in
                    self.candidateRow(candidate)
                }
            }
        } else if self.model.phase != .connected, self.model.detectError == nil {
            // A failed detect must not claim "nothing found" — the error card
            // below owns that state and the claim would be unproven.
            self.noCandidatesIntro
        }

        if let detectError = model.detectError {
            OnboardingErrorCard(
                title: self.model.configuredGatewayProbeUnavailable
                    ? "Couldn’t check this Gateway for AI accounts"
                    : "Couldn’t check this Mac for AI accounts",
                message: detectError.summary,
                details: detectError.detail,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                if self.model.configuredGatewayProbeUnavailable {
                    self.retryConfiguredGatewayProbe()
                } else {
                    self.model.retryFromScratch()
                }
            }
        }

        if let providerCatalogError = model.providerCatalogError {
            OnboardingErrorCard(
                title: "Couldn’t load the full provider list",
                message: providerCatalogError,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                self.model.retryFromScratch()
            }
        }

        if self.model.exhaustedAutoCandidates, !self.model.connected {
            OnboardingErrorCard(
                title: "None of the found options worked",
                message: """
                The details are listed on each option above. \
                You can fix the login and retry, or connect with an API key or token below.
                """,
                docsSlug: "concepts/model-providers",
                retryTitle: "Check again")
            {
                self.model.retryFromScratch()
            }
        }

        if !self.model.connected, self.model.providerCatalogLoaded {
            self.manualSection
        }

        if CrestodianAvailability.shouldShow(configuredModel: self.model.connectedModelRef) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    self.showCrestodianChat = true
                } label: {
                    Label("Need help? Chat with Crestodian", systemImage: "questionmark.bubble")
                        .font(.caption)
                }
                .buttonStyle(.link)
            }
        }
    }

    private var connectedBanner: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your AI is ready")
                    .font(.headline)
                Text(self.model.connectedSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.green.opacity(0.12)))
    }

    private var noCandidatesIntro: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No AI accounts found on this Mac")
                .font(.headline)
            Text(
                "That’s fine — you can connect one with an API key or token. " +
                    "If you use Claude Code, Codex, or the Gemini CLI on this Mac, " +
                    "sign in there first and hit “Check again”.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Check again") {
                self.model.retryFromScratch()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private func candidateRow(_ candidate: OnboardingAISetupModel.Candidate) -> some View {
        let status = self.model.statuses[candidate.kind] ?? .untried
        let selected = self.model.selectedKind == candidate.kind
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                self.model.userSelect(kind: candidate.kind)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: Self.symbol(for: candidate.kind))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(candidate.label)
                                .font(.callout.weight(.semibold))
                            if candidate.recommended, status != .connected {
                                Text("Recommended")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        Text(self.subtitle(for: candidate, status: status))
                            .font(.caption)
                            .foregroundStyle(self.subtitleStyle(for: status))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    self.trailingIndicator(status: status, selected: selected)
                }
            }
            .buttonStyle(.plain)
            .disabled(self.model.isBusy || self.model.connected)

            if case let .failed(failure) = status {
                OnboardingErrorDetails(text: failure.copyText)
                    .padding(.leading, 38)
                    .padding(.top, 6)
            }
        }
        .openClawSelectableRowChrome(selected: selected && !Self.isFailed(status))
    }

    private func subtitle(
        for candidate: OnboardingAISetupModel.Candidate,
        status: OnboardingAISetupModel.CandidateStatus) -> String
    {
        switch status {
        case .testing:
            "Testing — asking \(candidate.modelRef) for a quick reply…"
        case let .failed(failure):
            failure.summary
        case .connected:
            self.model.connectedSummary
        case .untried:
            "\(candidate.modelRef) · \(candidate.detail)"
        }
    }

    private func subtitleStyle(
        for status: OnboardingAISetupModel.CandidateStatus) -> Color
    {
        if case .failed = status {
            return .orange
        }
        return .secondary
    }

    @ViewBuilder
    private func trailingIndicator(
        status: OnboardingAISetupModel.CandidateStatus,
        selected: Bool) -> some View
    {
        switch status {
        case .testing:
            ProgressView()
                .controlSize(.small)
        case .connected:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        case .untried:
            SelectionStateIndicator(selected: selected)
        }
    }

    private static func symbol(for kind: String) -> String {
        switch kind {
        case "claude-cli": "sparkle"
        case "codex-cli": "chevron.left.forwardslash.chevron.right"
        case "gemini-cli": "diamond"
        case "existing-model": "checkmark.seal"
        default: "key.fill"
        }
    }

    private static func isFailed(_ status: OnboardingAISetupModel.CandidateStatus) -> Bool {
        if case .failed = status {
            return true
        }
        return false
    }

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.model.manualProviders.isEmpty {
                OnboardingErrorCard(
                    title: "No key-based providers are available",
                    message: "Enable or install a text-inference provider plugin on this Gateway, then check again.",
                    docsSlug: "concepts/model-providers",
                    retryTitle: "Check again")
                {
                    self.model.retryFromScratch()
                }
            } else if self.model.candidates.isEmpty || self.model.showManualEntry {
                self.manualForm
            } else {
                Button {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                        self.model.showManualEntry = true
                    }
                } label: {
                    Label("Connect with an API key or token instead…", systemImage: "key")
                        .font(.callout)
                }
                .buttonStyle(.link)
                .disabled(self.model.isBusy)
            }
        }
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect with an API key or token")
                .font(.headline)
            HStack(spacing: 8) {
                Picker("Provider", selection: self.$model.manualProviderID) {
                    ForEach(self.model.manualProviders) { provider in
                        Text(provider.label).tag(provider.id)
                    }
                }
                .labelsHidden()
                .frame(width: 230)

                SecureField("API key or token", text: self.$model.manualKey)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { self.model.submitManualKey() }

                Button {
                    self.model.submitManualKey()
                } label: {
                    if self.model.manualTesting {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: 74)
                    } else {
                        Text("Connect")
                            .frame(minWidth: 74)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.isBusy ||
                    self.model.manualKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Text(self.manualProviderHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let manualError = model.manualError {
                OnboardingErrorCard(
                    title: "That key didn’t work",
                    message: manualError.summary,
                    details: manualError.detail,
                    docsSlug: "concepts/model-providers",
                    retryTitle: nil,
                    retry: nil)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor)))
    }

    private var manualProviderHelp: String {
        let hint = self.model.selectedManualProvider?.hint?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hint, !hint.isEmpty else {
            return "Paste the key or token here, and OpenClaw checks it with a real test question."
        }
        return "\(hint). Paste it here, and OpenClaw checks it with a real test question."
    }

    private var crestodianSheet: some View {
        VStack(spacing: 8) {
            HStack {
                Label("Crestodian — setup helper", systemImage: "lifepreserver")
                    .font(.headline)
                Spacer(minLength: 0)
                Button("Done") {
                    self.showCrestodianChat = false
                }
            }
            .padding([.top, .horizontal], 14)
            CrestodianOnboardingChatView(model: self.crestodianChat)
                .task { await self.crestodianChat.startIfNeeded() }
        }
        .frame(width: 520, height: 480)
    }
}

/// Friendly error presentation with a consistent docs escape hatch.
/// Every onboarding failure points at a docs.openclaw.ai page so people are
/// never stuck staring at a raw error string.
struct OnboardingErrorCard: View {
    let title: String
    let message: String
    var details: String?
    let docsSlug: String
    var retryTitle: String?
    var retry: (() -> Void)?

    init(
        title: String,
        message: String,
        details: String? = nil,
        docsSlug: String,
        retryTitle: String? = nil,
        retry: (() -> Void)? = nil)
    {
        self.title = title
        self.message = message
        self.details = details
        self.docsSlug = docsSlug
        self.retryTitle = retryTitle
        self.retry = retry
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.callout.weight(.semibold))
                Text(self.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let details {
                    OnboardingErrorDetails(text: details)
                }
                HStack(spacing: 14) {
                    if let retryTitle, let retry {
                        Button(retryTitle, action: retry)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    Button("Open help…") {
                        if let url = URL(string: "https://docs.openclaw.ai/\(docsSlug)") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    if details == nil {
                        Button("Copy error") {
                            OnboardingErrorDetails.copy(self.message)
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                    }
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.orange.opacity(0.10)))
    }
}

private struct OnboardingErrorDetails: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    self.expanded.toggle()
                }
            } label: {
                Label(
                    self.expanded ? "Hide details" : "Show details",
                    systemImage: self.expanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.link)
            .font(.caption)

            if self.expanded {
                Text(self.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.primary.opacity(0.05)))
                Button {
                    Self.copy(self.text)
                } label: {
                    Label("Copy error", systemImage: "doc.on.doc")
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
