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
            OnboardingController.shared.busyReason = self.phase == .testing
                ? "OpenClaw is testing your AI connection."
                : nil
        }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var authOptions: [AuthOption] = []
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var connectedModelRef: String?
    private(set) var connectedLatencyMs: Int?
    private(set) var connectedSetupLines: [String] = []
    private(set) var codexAppServerDetected = false
    private(set) var detectError: Failure?
    /// Set once every detected candidate failed; opens the manual key form.
    private(set) var exhaustedAutoCandidates = false

    struct PersistedActivationState: Equatable {
        let setupComplete: Bool
        let configuredModel: String?
    }

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false
    private(set) var manualError: Failure?
    var showManualEntry = false
    private(set) var activeAuthOption: AuthOption?
    private(set) var authStep: WizardStep?
    private(set) var authError: Failure?
    private(set) var authBusy = false {
        didSet {
            if self.activeAuthOption != nil {
                OnboardingController.shared.busyReason = "OpenClaw is completing provider sign-in."
            } else if self.phase != .testing {
                OnboardingController.shared.busyReason = nil
            }
        }
    }

    var authText = ""
    var authSelection = 0
    var authConfirmation = true
    private var authSessionID: String?
    private var authAttemptID = UUID()
    /// Only a just-completed provider flow may trust setupComplete without re-probing.
    private var providerAuthReconciliationPending = false

    var selectedManualProvider: ManualProvider? {
        self.manualProviders.first { $0.id == self.manualProviderID }
    }

    var connected: Bool {
        self.phase == .connected
    }

    var isBusy: Bool {
        self.phase == .detecting || self.phase == .testing || self.manualTesting || self.authBusy
    }

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?

    private var started = false
    private var attemptToken = UUID()
    private var lastDetectedActivationState: PersistedActivationState?
    /// Detection, activation, and reconciliation must all stay on the server
    /// whose hello snapshot described the available setup contract.
    private var serverLease: GatewayConnection.ServerLease?

    private struct DetectResult: Decodable {
        struct DetectedCandidate: Decodable {
            let kind: String
            let label: String
            let detail: String
            let modelRef: String
            let credentials: Bool?
        }

        let candidates: [DetectedCandidate]
        let codexAppServerDetected: Bool?
        let manualProviders: [ManualProvider]?
        let authOptions: [AuthOption]?
        let workspace: String
        let configuredModel: String?
        let setupComplete: Bool

        var persistedActivationState: PersistedActivationState {
            PersistedActivationState(
                setupComplete: self.setupComplete,
                configuredModel: self.configuredModel)
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
        guard !self.started else { return }
        self.started = true
        Task { await self.detectAndAutoConnect() }
    }

    func retryFromScratch() {
        self.resetForGatewayChange()
        self.started = true
        Task { await self.detectAndAutoConnect() }
    }

    /// Cancel route-bound work and discard results that belong to the previous Gateway.
    func resetForGatewayChange() {
        let authSessionToCancel = self.authSessionID
        let authServerLease = self.serverLease
        self.attemptToken = UUID()
        self.started = false
        self.phase = .idle
        self.candidates = []
        self.manualProviders = []
        self.authOptions = []
        self.providerCatalogLoaded = false
        self.providerCatalogError = nil
        self.statuses = [:]
        self.selectedKind = nil
        self.connectedModelRef = nil
        self.connectedLatencyMs = nil
        self.connectedSetupLines = []
        self.codexAppServerDetected = false
        self.detectError = nil
        self.exhaustedAutoCandidates = false
        self.lastDetectedActivationState = nil
        self.serverLease = nil
        self.manualProviderID = ""
        self.manualKey = ""
        self.manualError = nil
        self.manualTesting = false
        self.showManualEntry = false
        self.activeAuthOption = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
        self.authSessionID = nil
        self.authAttemptID = UUID()
        self.providerAuthReconciliationPending = false
        if let authSessionToCancel, let authServerLease {
            Task {
                await GatewayConnection.shared.cancelWizardSession(
                    authSessionToCancel,
                    on: authServerLease)
            }
        }
    }
}

extension OnboardingAISetupModel {
    func detectAndAutoConnect() async {
        let token = self.attemptToken
        self.phase = .detecting
        self.detectError = nil
        self.providerCatalogError = nil
        do {
            let connection = GatewayConnection.shared
            let lease = try await connection.acquireServerLease()
            guard token == self.attemptToken else { return }
            self.serverLease = lease
            let data = try await connection.request(
                method: "crestodian.setup.detect",
                params: [:],
                timeoutMs: 20000,
                ifCurrentServerLease: lease)
            guard token == self.attemptToken else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            self.lastDetectedActivationState = result.persistedActivationState
            let manualProviders = result.manualProviders ?? []
            let authOptions = result.authOptions ?? []
            self.codexAppServerDetected = result.codexAppServerDetected ?? false
            self.candidates = result.candidates.map { detected in
                Candidate(
                    kind: detected.kind,
                    label: detected.label,
                    detail: detected.detail,
                    modelRef: detected.modelRef,
                    credentials: detected.credentials)
            }
            self.manualProviders = manualProviders
            self.authOptions = authOptions
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
            let providerAuthReconciliationPending = self.providerAuthReconciliationPending
            self.providerAuthReconciliationPending = false
            if Self.canAcceptProviderAuthReconciliation(
                pending: providerAuthReconciliationPending,
                setupComplete: result.setupComplete,
                configuredModel: result.configuredModel),
                let configuredModel = result.configuredModel
            {
                self.finishConnected(
                    kind: "provider-auth",
                    result: ActivateResult(
                        ok: true,
                        modelRef: configuredModel,
                        latencyMs: nil,
                        lines: nil,
                        status: nil,
                        error: nil))
                return
            }
            if let first = autoCandidateAfter(kind: nil) {
                // Candidate found: connect without asking. Switching later
                // stays one click away while the test runs server-side.
                await self.activate(kind: first.kind)
            } else {
                self.showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard token == self.attemptToken else { return }
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            self.showManualEntry = self.candidates.isEmpty
        }
    }

    static func canAcceptProviderAuthReconciliation(
        pending: Bool,
        setupComplete: Bool,
        configuredModel: String?) -> Bool
    {
        pending && setupComplete && configuredModel?.isEmpty == false
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

    static func activationRequestTimeoutMs(
        for kind: String,
        provisionsCodexSupervision: Bool = false) -> Double
    {
        // Codex can spend 305s installing its runtime plugin before the 90s live probe.
        // Keep a bounded client deadline with room for registry refresh and finalization.
        kind == "codex-cli" || provisionsCodexSupervision ? 480_000 : 150_000
    }

    static func activationOutcomeDeadlineMs(
        for kind: String,
        provisionsCodexSupervision: Bool = false) -> Double
    {
        // A request timeout removes only the client waiter. Keep a short final window
        // to observe config that the still-running Gateway operation just persisted.
        self.activationRequestTimeoutMs(
            for: kind,
            provisionsCodexSupervision: provisionsCodexSupervision) + 30000
    }

    static func activationTransitionWasPersisted(
        expectedModel: String,
        before: PersistedActivationState?,
        after: PersistedActivationState) -> Bool
    {
        guard let before else { return false }
        let wasAlreadyPersisted = before.setupComplete && before.configuredModel == expectedModel
        return !wasAlreadyPersisted && after.setupComplete && after.configuredModel == expectedModel
    }

    enum ActivationReconciliationMode: Equatable {
        case none
        case immediate
        case polling
    }

    static func activationReconciliationMode(after error: Error) -> ActivationReconciliationMode {
        // Decode failures happen after the side-effectful RPC returned bytes, so check persisted
        // state once. Only transport-unknown outcomes need the bounded polling window.
        if error is DecodingError {
            return .immediate
        }
        if error is GatewayResponseError ||
            error is GatewayConnectAuthError ||
            error is GatewayTLSValidationError ||
            error is OpenClawChatTransportSendError
        {
            return .none
        }
        return .polling
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
        Task { await self.activate(kind: kind) }
    }

    static func activationParams(
        kind: String,
        modelRef: String,
        supportsExactModel: Bool) -> [String: AnyCodable]
    {
        var params = ["kind": AnyCodable(kind)]
        if supportsExactModel {
            params["modelRef"] = AnyCodable(modelRef)
        }
        return params
    }

    func activate(kind: String) async {
        guard let candidate = candidates.first(where: { $0.kind == kind }) else { return }
        let token = self.attemptToken
        let persistedStateBeforeActivation = self.lastDetectedActivationState
        let clock = ContinuousClock()
        let requestTimeoutMs = Self.activationRequestTimeoutMs(
            for: kind,
            provisionsCodexSupervision: self.codexAppServerDetected)
        let outcomeDeadlineMs = Self.activationOutcomeDeadlineMs(
            for: kind,
            provisionsCodexSupervision: self.codexAppServerDetected)
        let reconciliationDeadline = clock.now.advanced(by: .milliseconds(Int64(outcomeDeadlineMs)))
        self.selectedKind = kind
        self.phase = .testing
        self.statuses[kind] = .testing
        guard let serverLease else {
            self.statuses[kind] = .failed(Self.transportFailure(
                OpenClawChatTransportSendError.notDispatched.localizedDescription))
            self.phase = .ready
            return
        }
        do {
            let connection = GatewayConnection.shared
            // Bind capability negotiation and activation to the server lease
            // that produced this candidate list.
            // Older gateways keep the legacy kind-only request shape.
            guard let supportsExactModel = await connection.supportsServerCapability(
                .crestodianSetupModelRef,
                ifCurrentServerLease: serverLease)
            else { throw OpenClawChatTransportSendError.notDispatched }
            let params = Self.activationParams(
                kind: kind,
                modelRef: candidate.modelRef,
                supportsExactModel: supportsExactModel)
            let data = try await connection.request(
                method: "crestodian.setup.activate",
                params: params,
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: serverLease)
            guard token == self.attemptToken else { return }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok {
                self.finishConnected(kind: kind, result: result)
            } else {
                self.statuses[kind] = .failed(Self.failure(
                    label: self.candidates.first { $0.kind == kind }?.label ?? kind,
                    status: result.status,
                    error: result.error))
                await self.tryNextAfterFailure(of: kind)
            }
        } catch {
            guard token == self.attemptToken else { return }
            // Activation can persist config before a response is decoded, and Codex plugin
            // setup can outlive a dropped socket. Re-read state with an error-specific budget.
            let reconciliationMode = Self.activationReconciliationMode(after: error)
            switch reconciliationMode {
            case .none:
                break
            case .immediate:
                if await self.reconcilePersistedActivation(
                    kind: kind,
                    token: token,
                    before: persistedStateBeforeActivation,
                    serverLease: serverLease)
                {
                    return
                }
            case .polling:
                if await self.reconcileActivationAfterUnknownOutcome(
                    kind: kind,
                    token: token,
                    before: persistedStateBeforeActivation,
                    deadline: reconciliationDeadline,
                    serverLease: serverLease)
                {
                    return
                }
            }
            guard token == self.attemptToken else { return }
            let failure = Self.transportFailure(error.localizedDescription)
            if await !(GatewayConnection.shared.isCurrentServerLease(serverLease)) {
                if reconciliationMode != .none {
                    // A successful local setup can restart the managed Gateway before its RPC reply
                    // reaches the app. Reconnect briefly and verify the exact persisted transition.
                    if await self.reconcileActivationAfterGatewayRestart(
                        kind: kind,
                        token: token,
                        before: persistedStateBeforeActivation,
                        originalServerLease: serverLease)
                    {
                        return
                    }
                }
                // The old candidate list is bound to the retired lease even when the
                // failure itself was definitive. Refresh before any retry.
                self.requireFreshDetection(after: failure)
                return
            }
            self.statuses[kind] = .failed(failure)
            // Do not start another provider after an RPC or protocol failure: setup may
            // already have applied, or a late Codex completion could race the next attempt.
            self.phase = .ready
        }
    }

    /// After a timeout or undecodable reply on the still-live setup socket,
    /// poll `crestodian.setup.detect` and accept only an exact state transition.
    private func reconcileActivationAfterUnknownOutcome(
        kind: String,
        token: UUID,
        before: PersistedActivationState?,
        deadline: ContinuousClock.Instant,
        serverLease: GatewayConnection.ServerLease) async -> Bool
    {
        let clock = ContinuousClock()
        var delayMs: UInt64 = 2000
        while clock.now < deadline {
            guard await GatewayConnection.shared.isCurrentServerLease(serverLease) else { return false }
            do {
                try await Task.sleep(nanoseconds: delayMs * 1_000_000)
            } catch {
                return false
            }
            guard token == self.attemptToken else { return false }
            delayMs = min(delayMs * 2, 15000)
            if await self.reconcilePersistedActivation(
                kind: kind,
                token: token,
                before: before,
                serverLease: serverLease)
            {
                return true
            }
            // A healthy detect can race the still-running activation; keep polling
            // instead of falling through to another provider.
        }
        return false
    }

    private func reconcileActivationAfterGatewayRestart(
        kind: String,
        token: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(30))
        var delayMs: UInt64 = 250
        while clock.now < deadline {
            guard token == self.attemptToken else { return false }
            let leaseTimeoutMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: 3000)
            guard leaseTimeoutMs > 0 else { return false }
            if let replacementLease = try? await GatewayConnection.shared.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: Double(leaseTimeoutMs)),
                await reconcilePersistedActivation(
                    kind: kind,
                    token: token,
                    before: before,
                    serverLease: replacementLease,
                    timeoutMs: Self.remainingMilliseconds(
                        until: deadline,
                        clock: clock,
                        cappedAt: 10000))
            {
                self.serverLease = replacementLease
                return true
            }
            let remainingSleepMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: Int(delayMs))
            guard remainingSleepMs > 0 else { return false }
            do {
                try await Task.sleep(nanoseconds: UInt64(remainingSleepMs) * 1_000_000)
            } catch {
                return false
            }
            delayMs = min(delayMs * 2, 2000)
        }
        return false
    }

    private func reconcilePersistedActivation(
        kind: String,
        token: UUID,
        before: PersistedActivationState?,
        serverLease: GatewayConnection.ServerLease,
        timeoutMs: Int = 10000) async -> Bool
    {
        guard timeoutMs > 0 else { return false }
        guard let expected = candidates.first(where: { $0.kind == kind })?.modelRef,
              let data = try? await GatewayConnection.shared.request(
                  method: "crestodian.setup.detect",
                  params: [:],
                  timeoutMs: Double(timeoutMs),
                  ifCurrentServerLease: serverLease),
              token == attemptToken,
              let result = try? JSONDecoder().decode(DetectResult.self, from: data),
              Self.activationTransitionWasPersisted(
                  expectedModel: expected,
                  before: before,
                  after: result.persistedActivationState)
        else {
            return false
        }
        self.finishConnected(
            kind: kind,
            result: ActivateResult(
                ok: true,
                modelRef: expected,
                latencyMs: nil,
                lines: nil,
                status: nil,
                error: nil))
        return true
    }

    private static func remainingMilliseconds(
        until deadline: ContinuousClock.Instant,
        clock: ContinuousClock,
        cappedAt capMs: Int) -> Int
    {
        let components = clock.now.duration(to: deadline).components
        let milliseconds = components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000
        return max(0, min(capMs, Int(milliseconds)))
    }

    func startProviderAuth(_ option: AuthOption) {
        guard !self.isBusy, self.activeAuthOption == nil, let serverLease else { return }
        self.activeAuthOption = option
        self.authStep = nil
        self.authError = nil
        self.authText = ""
        self.authBusy = true
        self.providerAuthReconciliationPending = false
        let token = self.attemptToken
        let authAttemptID = UUID()
        let authSessionID = UUID().uuidString
        self.authAttemptID = authAttemptID
        self.authSessionID = authSessionID
        Task {
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "crestodian.setup.auth.start",
                    params: [
                        "sessionId": AnyCodable(authSessionID),
                        "authChoice": AnyCodable(option.id),
                    ],
                    timeoutMs: 600_000,
                    ifCurrentServerLease: serverLease)
                let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else {
                    // A route reset can race the start response. Cancel the
                    // decoded server session so the discarded flow cannot commit.
                    await GatewayConnection.shared.cancelWizardSession(
                        result.sessionid,
                        on: serverLease)
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
                    error: result.error)
            } catch {
                // The Gateway session survives socket loss; cancel by its known
                // id before reporting failure so it cannot persist config later.
                let cancellation = await GatewayConnection.shared.cancelWizardSession(
                    authSessionID,
                    on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease)
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
        case "text": AnyCodable(self.authText)
        case "select": self.selectedAuthWizardOption?.value
        case "confirm": AnyCodable(self.authConfirmation)
        default: nil
        }
        self.advanceProviderAuth(stepID: step.id, value: value)
    }

    func cancelProviderAuth() {
        let sessionID = self.authSessionID
        let authServerLease = self.serverLease
        guard let sessionID, let authServerLease else {
            self.authAttemptID = UUID()
            self.providerAuthReconciliationPending = false
            self.clearProviderAuth()
            return
        }
        let authAttemptID = self.authAttemptID
        let token = self.attemptToken
        let activationState = self.lastDetectedActivationState
        self.authBusy = true
        Task {
            let cancellation = await GatewayConnection.shared.cancelWizardSession(
                sessionID,
                on: authServerLease)
            guard authAttemptID == self.authAttemptID else { return }
            if cancellation == .absent,
               await self.reconcileProviderAuthAfterUnknownOutcome(
                   token: token,
                   before: activationState,
                   originalServerLease: authServerLease)
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
        parseWizardOptions(self.authStep?.options)
    }

    var selectedAuthWizardOption: WizardOption? {
        let options = self.authWizardOptions
        guard options.indices.contains(self.authSelection) else { return options.first }
        return options[self.authSelection]
    }

    private func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
        guard let sessionID = authSessionID, let serverLease else { return }
        self.authBusy = true
        self.authError = nil
        var params: [String: AnyCodable] = ["sessionId": AnyCodable(sessionID)]
        if let stepID {
            var answer: [String: AnyCodable] = ["stepId": AnyCodable(stepID)]
            if let value {
                answer["value"] = value
            }
            params["answer"] = AnyCodable(answer)
        }
        let token = self.attemptToken
        let authAttemptID = self.authAttemptID
        Task {
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "wizard.next",
                    params: params,
                    timeoutMs: Self.providerAuthRequestTimeoutMs,
                    ifCurrentServerLease: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                let result = try JSONDecoder().decode(WizardNextResult.self, from: data)
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error)
            } catch {
                let cancellation = await GatewayConnection.shared.cancelWizardSession(
                    sessionID,
                    on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease)
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
        error: String?)
    {
        self.authBusy = false
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && self.authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            // Terminal sessions are removed by the Gateway. Drop the local id
            // so Cancel dismisses the preserved, copyable error immediately.
            self.authSessionID = nil
            self.authStep = nil
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "unavailable",
                error: error)
            return
        }
        if status == "cancelled" {
            self.clearProviderAuth()
            return
        }
        if done || status == "done" {
            self.providerAuthReconciliationPending = true
            self.clearProviderAuth()
            Task { await self.detectAndAutoConnect() }
            return
        }
        self.authStep = step
        if validationError {
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "format",
                error: error)
        }
        if !preserveEnteredValue {
            self.authText = anyCodableString(step?.initialvalue)
        }
        self.authConfirmation = anyCodableBool(step?.initialvalue)
        let options = parseWizardOptions(step?.options)
        self.authSelection = max(0, options.firstIndex {
            anyCodableEqual($0.value, step?.initialvalue)
        } ?? 0)
    }

    private func reconcileProviderAuthAfterUnknownOutcome(
        token: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        guard let before else { return false }
        let connection = GatewayConnection.shared
        let lease: GatewayConnection.ServerLease
        if await connection.isCurrentServerLease(originalServerLease) {
            lease = originalServerLease
        } else {
            guard let replacement = try? await connection.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: 5000)
            else { return false }
            lease = replacement
        }
        guard let data = try? await connection.request(
            method: "crestodian.setup.detect",
            params: [:],
            timeoutMs: 10000,
            ifCurrentServerLease: lease),
            token == self.attemptToken,
            let result = try? JSONDecoder().decode(DetectResult.self, from: data),
            let configuredModel = result.configuredModel,
            Self.activationTransitionWasPersisted(
                expectedModel: configuredModel,
                before: before,
                after: result.persistedActivationState)
        else { return false }
        self.serverLease = lease
        self.clearProviderAuth()
        self.finishConnected(
            kind: "provider-auth",
            result: ActivateResult(
                ok: true,
                modelRef: configuredModel,
                latencyMs: nil,
                lines: nil,
                status: nil,
                error: nil))
        return true
    }

    private func clearProviderAuth() {
        self.activeAuthOption = nil
        self.authSessionID = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
    }

    func submitManualKey() {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider,
              let serverLease,
              !key.isEmpty,
              !self.manualTesting
        else { return }
        self.manualError = nil
        self.manualTesting = true
        let token = self.attemptToken
        Task {
            defer {
                if token == self.attemptToken {
                    self.manualTesting = false
                }
            }
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "crestodian.setup.activate",
                    params: [
                        "kind": AnyCodable("api-key"),
                        "authChoice": AnyCodable(provider.id),
                        "apiKey": AnyCodable(key),
                    ],
                    timeoutMs: Self.activationRequestTimeoutMs(
                        for: "api-key",
                        provisionsCodexSupervision: self.codexAppServerDetected),
                    ifCurrentServerLease: serverLease)
                guard token == self.attemptToken else { return }
                let result = try JSONDecoder().decode(ActivateResult.self, from: data)
                if result.ok {
                    self.manualKey = ""
                    self.finishConnected(kind: "api-key", result: result)
                } else {
                    self.manualError = Self.failure(
                        label: provider.label,
                        status: result.status,
                        error: result.error)
                }
            } catch {
                guard token == self.attemptToken else { return }
                // Manual activation has no expected model or activation id. A
                // detect transition could belong to another setup operation,
                // so an unknown transport outcome must remain an error.
                let failure = Self.transportFailure(error.localizedDescription)
                if await !(GatewayConnection.shared.isCurrentServerLease(serverLease)) {
                    self.requireFreshDetection(after: failure)
                    return
                }
                self.manualError = failure
            }
        }
    }

    /// A retired socket invalidates every candidate and provider record learned
    /// from that server generation. Preserve the error, but require a fresh
    /// detection lease before the user can dispatch another setup mutation.
    func requireFreshDetection(after failure: Failure) {
        self.resetForGatewayChange()
        self.phase = .ready
        self.detectError = failure
    }

    private func finishConnected(kind: String, result: ActivateResult) {
        self.statuses[kind] = .connected
        self.selectedKind = kind
        self.connectedModelRef = result.modelRef
        self.connectedLatencyMs = result.latencyMs.map { Int($0.rounded()) }
        self.connectedSetupLines = Self.normalizedSetupLines(result.lines)
        self.phase = .connected
        self.onConnected?()
    }

    static func normalizedSetupLines(_ lines: [String]?) -> [String] {
        (lines ?? []).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    private func tryNextAfterFailure(of kind: String) async {
        if let next = autoCandidateAfter(kind: kind) {
            await self.activate(kind: next.kind)
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
        let label = self.candidates.first { $0.kind == self.selectedKind }?.label ??
            (self.selectedKind == "api-key" ? self.selectedManualProvider?.label : nil)
        let via = label.map { " via \($0)" } ?? ""
        if let latency = connectedLatencyMs {
            let seconds = Double(latency) / 1000
            return "\(modelRef)\(via) — replied in \(String(format: "%.1f", seconds))s"
        }
        return "\(modelRef)\(via)"
    }

    var connectedSetupCopyText: String {
        self.connectedSetupLines.joined(separator: "\n")
    }

    #if DEBUG
    func _test_setConnectedSetupLines(_ lines: [String]?) {
        self.connectedSetupLines = Self.normalizedSetupLines(lines)
    }

    func _test_setProviderAuth(option: AuthOption, sessionID: String) {
        self.activeAuthOption = option
        self.authSessionID = sessionID
        self.authBusy = true
    }

    func _test_applyAuthWizardResult(done: Bool, status: String?, error: String?) {
        self.applyAuthWizardResult(done: done, step: nil, status: status, error: error)
    }

    var _test_authSessionID: String? {
        self.authSessionID
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
