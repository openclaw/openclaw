import Foundation
import Network
import Observation
import OpenClawKit
import SwiftUI

typealias GatewayTCPReachabilityProbe = @Sendable (String, Int, Double, String) async -> Bool
typealias GatewayServiceEndpointResolver = @Sendable (NWEndpoint) async -> (host: String, port: Int)?
typealias GatewayForceReconnectReset = @MainActor (NodeAppModel) async -> Void
typealias GatewayTLSFingerprintPersist = @Sendable (_ fingerprint: String, _ stableID: String) -> Bool

@MainActor
@Observable
final class GatewayConnectionController {
    struct AutoConnectSuppressionLease {
        fileprivate let generation: UInt64
        fileprivate let previousAutoReconnectEnabled: Bool
        fileprivate let restoresAutoReconnect: Bool
        fileprivate let suspendedConfig: GatewayConnectConfig?
    }

    private enum PreconnectRetryTarget {
        case manual(host: String, port: Int, useTLS: Bool, contextPath: String?, authOverride: ManualAuthOverride?)
        case discovered(GatewayDiscoveryModel.DiscoveredGateway)
    }

    private struct PreconnectRetryContext {
        let target: PreconnectRetryTarget
        let stableID: String
        let attemptGeneration: UInt64
        let gatewayGeneration: UInt64?
    }

    private struct GatewayRestoration {
        let config: GatewayConnectConfig
        var generation: UInt64
        var replacementStableID: String?
    }

    private(set) var gateways: [GatewayDiscoveryModel.DiscoveredGateway] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [GatewayDiscoveryModel.DebugLogEntry] = []
    private(set) var pendingTrustPrompt: TrustPrompt?
    let operatorFleet = GatewayOperatorFleet()
    @ObservationIgnored lazy var ingress = GatewayIngressController { [weak self] origin in
        guard let self else { return }
        await self.operatorFleet.retire(origin: origin)
        await self.appModel?.retireGatewayIngress(for: origin)
    }

    private let discovery: GatewayDiscoveryModel
    private let discoveryEnabled: Bool
    private(set) weak var appModel: NodeAppModel?
    private var localNetworkAccessRequested: Bool
    private(set) var currentScenePhase: ScenePhase = .inactive
    private var didAutoConnect = false
    private var pendingServiceResolvers: [String: BonjourServiceResolver<(host: String, port: Int)>] = [:]
    private var pendingTrustConnect: GatewayPendingTrustConnect?
    private var preconnectRetryContext: PreconnectRetryContext?
    private var trustProbeGeneration: UInt64 = 0
    private var connectAttemptGeneration: UInt64 = 0
    private var autoConnectSuppression: AutoConnectSuppressionLease?
    @ObservationIgnored private var pendingAutoConnectTask: Task<Void, Never>?
    @ObservationIgnored var operatorFleetReconcileTask: Task<Void, Never>?
    private var pendingAutoConnectGeneration: UInt64?
    @ObservationIgnored private var pendingAutoConnectSuppressionGeneration: UInt64?
    @ObservationIgnored private var pendingGatewayRestoration: GatewayRestoration?
    @ObservationIgnored private var pendingForgetCleanups: [
        GatewayStableIdentifier.Key: (id: UUID, task: Task<Bool, Never>)
    ] = [:]
    private var pendingConnectionStableID: String?
    private let tcpReachabilityProbe: GatewayTCPReachabilityProbe
    private let tlsFingerprintProbe: GatewayTLSFingerprintProbeFunction
    let serviceEndpointResolver: GatewayServiceEndpointResolver?
    private let forceReconnectReset: GatewayForceReconnectReset
    private let persistTLSFingerprint: GatewayTLSFingerprintPersist
    let autoConnectRetryDelay: @MainActor (Duration) async throws -> Void
    let now: () -> Date

    init(
        appModel: NodeAppModel,
        startDiscovery: Bool = true,
        discovery: GatewayDiscoveryModel = GatewayDiscoveryModel(),
        deferDiscoveryUntilLocalNetworkRequest: Bool = false,
        tcpReachabilityProbe: @escaping GatewayTCPReachabilityProbe = TCPProbe.probe,
        tlsFingerprintProbe: @escaping GatewayTLSFingerprintProbeFunction = defaultGatewayTLSFingerprintProbe,
        serviceEndpointResolver: GatewayServiceEndpointResolver? = nil,
        forceReconnectReset: @escaping GatewayForceReconnectReset = { appModel in
            await appModel.resetGatewaySessionsForForcedReconnect()
        },
        persistTLSFingerprint: @escaping GatewayTLSFingerprintPersist = { fingerprint, stableID in
            GatewayTLSStore.replaceFingerprint(fingerprint, stableID: stableID)
        },
        autoConnectRetryDelay: @escaping @MainActor (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        ingress: GatewayIngressController? = nil,
        now: @escaping () -> Date = Date.init)
    {
        self.discovery = discovery
        self.discoveryEnabled = startDiscovery
        self.appModel = appModel
        self.localNetworkAccessRequested = !deferDiscoveryUntilLocalNetworkRequest
        self.tcpReachabilityProbe = tcpReachabilityProbe
        self.tlsFingerprintProbe = tlsFingerprintProbe
        self.serviceEndpointResolver = serviceEndpointResolver
        self.forceReconnectReset = forceReconnectReset
        self.persistTLSFingerprint = persistTLSFingerprint
        self.autoConnectRetryDelay = autoConnectRetryDelay
        self.now = now
        if let ingress {
            self.ingress = ingress
        }

        GatewaySettingsStore.bootstrapPersistence()
        Self.migrateLegacyDeviceAuth()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "gateway.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if self.discoveryEnabled, self.localNetworkAccessRequested {
            self.discovery.start()
        }
    }

    /// Acceptance can precede trust review, queued reset, and permission reads.
    /// UI callers must protect the old composer until this owner finishes the
    /// handoff (or its cancellation/restoration barrier), not until acceptance.
    var hasPendingConnectionHandoff: Bool {
        self.pendingConnectionStableID != nil ||
            self.pendingTrustPrompt != nil ||
            self.pendingAutoConnectGeneration != nil
    }

    /// Registration consumes the app-owned permission snapshot; constructing a location
    /// manager on this hot path can synchronously block the main thread on Core Location.
    var locationAuthorizationSnapshot: LocationAuthorizationSnapshot {
        self.appModel?.locationAuthorizationSnapshot ?? .undetermined
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func selectReachableSetupLink(_ link: GatewayConnectDeepLink) async -> GatewayConnectDeepLink {
        let endpoints = link.connectionEndpoints
        guard endpoints.count > 1 else { return link }
        // Probe before persisting: a setup code may carry LAN and Tailnet routes,
        // but only the route reachable from the phone should become its saved endpoint.
        self.requestLocalNetworkAccess(reason: "setup_route_probe")
        for (index, endpoint) in endpoints.enumerated() {
            let reachable = await self.tcpReachabilityProbe(
                endpoint.host,
                endpoint.port,
                GatewaySetupRouteProbeBudget.tcpConnectTimeoutSeconds,
                "ai.openclaw.gateway.setup-route-\(index)")
            if reachable {
                return link.selectingEndpoint(endpoint)
            }
        }
        return link
    }

    func requestLocalNetworkAccess(reason: String, allowAutoReconnect: Bool = true) {
        guard self.discoveryEnabled else {
            self.discovery.stop()
            self.updateFromDiscovery(allowAutoConnect: allowAutoReconnect)
            return
        }

        self.localNetworkAccessRequested = true
        GatewayDiagnostics.log("local network access requested reason=\(reason)")

        guard self.currentScenePhase != .background else { return }
        self.discovery.start()
        self.updateFromDiscovery(allowAutoConnect: allowAutoReconnect)
        guard allowAutoReconnect else { return }
        self.attemptAutoReconnectIfNeeded()
    }

    func setScenePhase(_ phase: ScenePhase) {
        self.currentScenePhase = phase
        if phase == .active {
            self.ingress.foregrounded()
            scheduleOperatorFleetReconcile()
        } else if phase == .background {
            self.cancelOperatorFleetReconcile()
            self.operatorFleet.stopAll()
        }
        guard self.discoveryEnabled else {
            self.discovery.stop()
            return
        }
        guard self.localNetworkAccessRequested else { return }

        if phase == .background {
            self.discovery.stop()
        } else {
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        }
    }

    func restartDiscovery() {
        guard self.discoveryEnabled else {
            self.discovery.stop()
            self.updateFromDiscovery()
            return
        }
        guard self.localNetworkAccessRequested else {
            self.requestLocalNetworkAccess(reason: "restart_discovery")
            return
        }

        self.discovery.stop()
        self.didAutoConnect = false
        self.discovery.start()
        self.updateFromDiscovery()
    }

    /// Direct setup callers keep their existing diagnostic contract while registered
    /// reconnect and switch actions consume the closed attempt result below.
    func connectWithDiagnostics(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async -> String? {
        if case let .failed(message) = await self.connectDiscoveredGateway(gateway) {
            return message
        }
        return nil
    }

    private func connectDiscoveredGateway(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway,
        forceReconnect: Bool = false,
        userInitiated: Bool = true,
        admissionCheckpoint: UInt64? = nil) async -> ConnectionAttemptResult
    {
        let availability = self.discoveredGatewayConnectionAvailability(gateway)
        guard availability.canConnect else {
            return .failed(availability.guidanceText ?? String(localized: "This gateway is unavailable."))
        }

        let connectAttempt = beginConnectAttempt(
            targetStableID: gateway.stableID,
            admissionCheckpoint: admissionCheckpoint)
        self.preconnectRetryContext = PreconnectRetryContext(
            target: .discovered(gateway),
            stableID: gateway.stableID,
            attemptGeneration: connectAttempt.suppressionLease.generation,
            gatewayGeneration: connectAttempt.gatewayGeneration)
        self.pendingConnectionStableID = gateway.stableID
        defer { self.finishConnectAttempt(connectAttempt.suppressionLease) }
        await self.waitForPendingForgetCleanup(stableID: gateway.stableID)
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return .superseded }
        self.requestLocalNetworkAccess(reason: "connect_discovered_gateway", allowAutoReconnect: false)
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if instanceId.isEmpty {
            return .failed("Missing instanceId (node.instanceId). Try restarting the app.")
        }
        // Resolve the service endpoint (SRV/A/AAAA). TXT is unauthenticated; do not route via TXT.
        let target = await self.resolveServiceEndpoint(gateway.endpoint)
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return .superseded }
        guard let target else {
            return .failed("Failed to resolve the discovered gateway endpoint.")
        }

        let stableID = gateway.stableID
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: stableID)
        // Discovery is a LAN operation; refuse unauthenticated plaintext connects.
        guard let stored = GatewayTLSStore.loadFingerprint(stableID: stableID) else {
            guard let url = self.buildGatewayURL(host: target.host, port: target.port, useTLS: true)
            else { return .failed("Failed to build TLS URL for trust verification.") }
            return await self.resolveFirstUseTLS(
                host: target.host,
                port: target.port,
                gatewayName: gateway.name,
                pendingConnect: GatewayPendingTrustConnect(
                    url: url,
                    stableID: stableID,
                    isManual: false,
                    authOverride: nil,
                    allowStoredDeviceAuth: true,
                    suppressionLease: connectAttempt.suppressionLease,
                    gatewayGeneration: connectAttempt.gatewayGeneration,
                    admissionCheckpoint: connectAttempt.admissionCheckpoint,
                    userInitiated: userInitiated)) ?? .superseded
        }

        let tlsParams = GatewayTLSParams(
            required: true, expectedFingerprint: stored, allowTOFU: false, storeKey: stableID)

        guard let url = self.buildGatewayURL(
            host: target.host,
            port: target.port,
            useTLS: true)
        else { return .failed("Failed to build discovered gateway URL.") }
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .discovered,
            name: gateway.name,
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else {
            return .failed("Could not save the paired gateway.")
        }
        self.didAutoConnect = true
        let didStart = self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: credentials.token,
            bootstrapToken: credentials.bootstrapToken,
            password: credentials.password,
            allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth,
            forceReconnect: forceReconnect,
            suppressionGeneration: connectAttempt.suppressionLease.generation,
            expectedGeneration: connectAttempt.gatewayGeneration,
            admissionCheckpoint: connectAttempt.admissionCheckpoint,
            userInitiated: userInitiated)
        return didStart ? .accepted : .superseded
    }

    @discardableResult
    func connectManual(
        host: String,
        port: Int,
        useTLS: Bool,
        contextPath: String? = nil,
        authOverride: ManualAuthOverride? = nil,
        forceReconnect: Bool = false,
        admissionCheckpoint: UInt64? = nil) async -> ConnectionAttemptResult
    {
        let authOverride = authOverride?.unconsumed
        let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
        let resolvedPort = Self.resolvedManualPort(host: host, port: port)
        let stableID = resolvedPort.map {
            self.manualStableID(host: host, port: $0, contextPath: contextPath)
        }
        let connectAttempt = beginConnectAttempt(targetStableID: stableID, admissionCheckpoint: admissionCheckpoint)
        defer { self.finishConnectAttempt(connectAttempt.suppressionLease) }
        self.requestLocalNetworkAccess(reason: "connect_manual", allowAutoReconnect: false)
        guard let resolvedPort, let stableID
        else { return .failed(String(localized: "This paired gateway has an invalid saved endpoint.")) }
        self.preconnectRetryContext = PreconnectRetryContext(
            target: .manual(
                host: host,
                port: resolvedPort,
                useTLS: resolvedUseTLS,
                contextPath: contextPath,
                authOverride: authOverride),
            stableID: stableID,
            attemptGeneration: connectAttempt.suppressionLease.generation,
            gatewayGeneration: connectAttempt.gatewayGeneration)
        self.pendingConnectionStableID = stableID
        await self.waitForPendingForgetCleanup(stableID: stableID)
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return .superseded }
        guard admitSetupLifetime(authOverride, stableID: stableID, generation: connectAttempt.gatewayGeneration)
        else { return .failed(String(localized: "Gateway setup code has expired.")) }
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let storedCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: stableID)
        let token = authOverride.map(\.token) ?? storedCredentials.token
        let bootstrapToken = authOverride.map(\.bootstrapToken) ?? storedCredentials.bootstrapToken
        let password = authOverride.map(\.password) ?? storedCredentials.password
        let suppressStoredDeviceAuth =
            authOverride?.suppressStoredDeviceAuth ?? storedCredentials.suppressStoredDeviceAuth
        let pendingAuthOverride = authOverride ?? (storedCredentials.hasCredentials
            ? ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                targetStableID: stableID,
                suppressStoredDeviceAuth: suppressStoredDeviceAuth)
            : nil)
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        let setupFingerprint = GatewayStableIdentifier.matches(authOverride?.targetStableID, stableID)
            ? authOverride?.tlsFingerprintSha256
            : nil
        let isSetupCodeOrigin = authOverride?.isSetupCodeOrigin == true &&
            GatewayStableIdentifier.matches(authOverride?.targetStableID, stableID)
        guard resolvedUseTLS || setupFingerprint == nil else {
            return .failed(String(localized: "A TLS certificate fingerprint requires a secure gateway URL."))
        }
        if let setupVerificationFailure = await self.verifySetupFingerprint(
            setupFingerprint,
            host: host,
            port: resolvedPort,
            contextPath: contextPath,
            stableID: stableID,
            attemptGeneration: connectAttempt.suppressionLease.generation,
            gatewayGeneration: connectAttempt.gatewayGeneration)
        {
            return setupVerificationFailure
        }
        guard !Task.isCancelled,
              self.connectAttemptGeneration == connectAttempt.suppressionLease.generation,
              connectAttempt.gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else { return .superseded }
        if let setupFingerprint, setupFingerprint != stored,
           !self.persistTLSFingerprint(setupFingerprint, stableID)
        {
            let message = String(localized: "Could not save gateway certificate")
            self.appModel?.gatewayStatusText = message
            return .failed(message)
        }
        var expectedFingerprint = setupFingerprint ?? stored
        if resolvedUseTLS, expectedFingerprint == nil {
            guard let url = self.buildGatewayURL(
                host: host,
                port: resolvedPort,
                useTLS: true,
                contextPath: contextPath)
            else { return .failed(String(localized: "Failed to build the gateway URL.")) }
            let pendingTrustConnect = GatewayPendingTrustConnect(
                url: url,
                stableID: stableID,
                isManual: true,
                authOverride: pendingAuthOverride,
                allowStoredDeviceAuth: !suppressStoredDeviceAuth,
                suppressionLease: connectAttempt.suppressionLease,
                gatewayGeneration: connectAttempt.gatewayGeneration,
                admissionCheckpoint: connectAttempt.admissionCheckpoint)
            if let trustResult = await self.resolveFirstUseTLS(
                host: host,
                port: resolvedPort,
                gatewayName: "\(host):\(resolvedPort)",
                pendingConnect: pendingTrustConnect,
                isSetupCodeOrigin: isSetupCodeOrigin)
            { return trustResult }
        }

        expectedFingerprint = setupFingerprint ?? GatewayTLSStore.loadFingerprint(stableID: stableID)
        let tlsParams = resolvedUseTLS
            ? GatewayTLSParams(
                required: true,
                expectedFingerprint: expectedFingerprint,
                allowTOFU: false,
                storeKey: stableID)
            : nil
        guard let url = self.buildGatewayURL(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true,
            contextPath: contextPath)
        else { return .failed(String(localized: "Failed to build the gateway URL.")) }
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .manual,
            name: "\(host):\(resolvedPort)",
            host: host,
            port: resolvedPort,
            useTLS: resolvedUseTLS,
            contextPath: contextPath,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else {
            self.restoreStoredFingerprint(stored, afterAttempting: setupFingerprint, stableID: stableID)
            return .failed(String(localized: "Could not save the paired gateway."))
        }
        self.didAutoConnect = true
        let didStart = self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            allowStoredDeviceAuth: !suppressStoredDeviceAuth,
            forceReconnect: forceReconnect,
            suppressionGeneration: connectAttempt.suppressionLease.generation,
            expectedGeneration: connectAttempt.gatewayGeneration,
            admissionCheckpoint: connectAttempt.admissionCheckpoint,
            authOverride: authOverride,
            userInitiated: true)
        if !didStart {
            self.restoreStoredFingerprint(stored, afterAttempting: setupFingerprint, stableID: stableID)
            return .superseded
        }
        return .accepted
    }
}

extension GatewayConnectionController {
    @discardableResult
    func retryGatewayConnection() async -> ConnectionAttemptResult {
        if let retry = self.currentPreconnectRetry {
            // The saved gateway can still be the old route. Retry the producer-owned attempt
            // with its unconsumed setup pin and credentials, not that persisted selection.
            return await self.retryPreconnect(retry)
        }
        self.preconnectRetryContext = nil
        if let attention = ingress.attention,
           let active = GatewaySettingsStore.activeGatewayEntry(),
           GatewayStableIdentifier.matches(active.stableID, attention.stableID) ||
           active.accessOrigin == attention.origin
        {
            return await self.retryGatewayIngress(attention)
        }
        return await self.connectActiveGateway()
    }

    private func retryPreconnect(_ retry: PreconnectRetryContext) async -> ConnectionAttemptResult {
        switch retry.target {
        case let .manual(host, port, useTLS, contextPath, authOverride):
            await self.connectManual(
                host: host,
                port: port,
                useTLS: useTLS,
                contextPath: contextPath,
                authOverride: authOverride,
                forceReconnect: true)
        case let .discovered(gateway):
            await self.connectDiscoveredGateway(gateway, forceReconnect: true)
        }
    }

    @discardableResult
    func retryGatewayIngress(_ attention: GatewayIngressController.Attention) async -> ConnectionAttemptResult {
        let admissionCheckpoint = self.ingress.admissionCheckpoint()
        guard self.ingress.attention?.id == attention.id else { return .superseded }
        if let retry = currentPreconnectRetry,
           GatewayStableIdentifier.matches(retry.stableID, attention.stableID)
        {
            return await self.retryGatewayConnection()
        }
        if GatewayStableIdentifier.matches(GatewaySettingsStore.activeGatewayEntry()?.stableID, attention.stableID) {
            // A restored grant can be signed out before any route was prepared.
            // Rebuild the active profile through its normal TLS/endpoint owner.
            return await self.connectActiveGateway(admissionCheckpoint: admissionCheckpoint)
        }
        guard let appModel else { return .superseded }
        let gatewayGeneration = appModel.gatewayConnectGeneration
        let attemptGeneration = self.connectAttemptGeneration
        let activeID = GatewaySettingsStore.activeGatewayEntry()?.id
        do {
            try await self.ingress.signIn(for: attention, admissionCheckpoint: admissionCheckpoint)
            guard !Task.isCancelled, appModel.gatewayConnectGeneration == gatewayGeneration,
                  self.connectAttemptGeneration == attemptGeneration,
                  GatewaySettingsStore.activeGatewayEntry()?.id == activeID
            else { return .superseded }
            scheduleOperatorFleetReconcile(admissionCheckpoint: admissionCheckpoint)
            // One origin can serve several profiles. Renewing background attention
            // must also restore its still-desired active profile, without replaying setup auth.
            if appModel.activeGatewayConnectConfig == nil,
               GatewaySettingsStore.activeGatewayEntry()?.accessOrigin == attention.origin
            {
                return await self.connectActiveGateway(admissionCheckpoint: admissionCheckpoint)
            }
            return .accepted
        } catch is CancellationError {
            return .superseded
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    var pendingGatewayRetryKind: GatewaySettingsStore.GatewayRegistryEntry.Kind? {
        switch self.currentPreconnectRetry?.target {
        case .manual: .manual
        case .discovered: .discovered
        case nil: nil
        }
    }

    private var currentPreconnectRetry: PreconnectRetryContext? {
        guard let retry = self.preconnectRetryContext,
              retry.attemptGeneration == self.connectAttemptGeneration,
              retry.gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else { return nil }
        // Browser cancellation belongs to ingress guidance, not the model's network-error slot.
        // Its settled, same-target action must retain the setup receipt just like a failed probe.
        let ingressRetry = self.pendingAutoConnectGeneration == nil &&
            self.ingress.attention?.canSignIn == true &&
            GatewayStableIdentifier.matches(self.ingress.attention?.stableID, retry.stableID)
        guard self.appModel?.hasGatewayPreconnectProblem(for: retry.stableID) == true || ingressRetry
        else { return nil }
        return retry
    }

    @discardableResult
    func connectActiveGateway(admissionCheckpoint: UInt64? = nil) async -> ConnectionAttemptResult {
        let admissionCheckpoint = admissionCheckpoint ?? self.ingress.admissionCheckpoint()
        self.requestLocalNetworkAccess(reason: "connect_active_gateway", allowAutoReconnect: false)
        guard let active = GatewaySettingsStore.activeGatewayEntry() else {
            return .failed(String(localized: "No paired gateway is available to reconnect."))
        }
        return await self.connectRegisteredGateway(
            active,
            allowManualFallback: true,
            activate: false,
            admissionCheckpoint: admissionCheckpoint)
    }

    @discardableResult
    func switchToGateway(stableID: String) async -> ConnectionAttemptResult {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else {
            return .failed(String(localized: "This paired gateway is no longer available."))
        }
        guard let entry = GatewaySettingsStore.loadGatewayRegistry().entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        }) else {
            return .failed(String(localized: "This paired gateway is no longer available."))
        }
        return await self.connectRegisteredGateway(entry, allowManualFallback: false, activate: true)
    }

    private func connectRegisteredGateway(
        _ entry: GatewaySettingsStore.GatewayRegistryEntry,
        allowManualFallback: Bool,
        activate: Bool,
        admissionCheckpoint: UInt64? = nil) async -> ConnectionAttemptResult
    {
        let admissionCheckpoint = admissionCheckpoint ?? self.ingress.admissionCheckpoint()
        // Saved-profile actions share the pending setup attempt with the dedicated Retry
        // action. Reloading its persisted credentials would discard the original expiry.
        if let retry = self.currentPreconnectRetry,
           GatewayStableIdentifier.matches(retry.stableID, entry.stableID)
        {
            return await self.retryPreconnect(retry)
        }
        switch entry.kind {
        case .manual:
            guard let host = entry.host, let port = entry.port else {
                return .failed(String(localized: "This paired gateway has an invalid saved endpoint."))
            }
            if activate, !GatewaySettingsStore.setActiveGateway(stableID: entry.stableID) {
                return .failed(String(localized: "Could not save the active gateway selection."))
            }
            return await self.connectManual(
                host: host,
                port: port,
                useTLS: entry.useTLS,
                contextPath: entry.contextPath,
                forceReconnect: true,
                admissionCheckpoint: admissionCheckpoint)
        case .discovered:
            guard let gateway = self.gateways.first(where: {
                GatewayStableIdentifier.matches($0.stableID, entry.stableID)
            }) else {
                if allowManualFallback, let fallback = self.mostRecentlyConnectedManualGateway() {
                    return await self.connectRegisteredGateway(
                        fallback,
                        allowManualFallback: false,
                        activate: true,
                        admissionCheckpoint: admissionCheckpoint)
                }
                return .failed(String(
                    format: String(localized: "%@ is not currently discoverable on this network."),
                    entry.name))
            }
            if activate, !GatewaySettingsStore.setActiveGateway(stableID: entry.stableID) {
                return .failed(String(localized: "Could not save the active gateway selection."))
            }
            return await self.connectDiscoveredGateway(
                gateway,
                forceReconnect: true,
                admissionCheckpoint: admissionCheckpoint)
        }
    }

    @discardableResult
    func forgetGateway(stableID: String) async -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID),
              let stableIDKey = GatewayStableIdentifier.key(stableID)
        else { return false }
        if let pending = self.pendingForgetCleanups[stableIDKey] {
            return await pending.task.value
        }
        let cleanupID = UUID()
        let cleanupTask = Task { @MainActor [weak self] in
            guard let self else { return false }
            return await self.performForgetGateway(stableID: stableID)
        }
        self.pendingForgetCleanups[stableIDKey] = (cleanupID, cleanupTask)
        let result = await cleanupTask.value
        if self.pendingForgetCleanups[stableIDKey]?.id == cleanupID {
            self.pendingForgetCleanups[stableIDKey] = nil
            scheduleOperatorFleetReconcile()
        }
        return result
    }

    private func performForgetGateway(stableID: String) async -> Bool {
        cancelOperatorFleetReconcile()
        do { try await self.ingress.forget(stableID: stableID) } catch { return false }
        self.operatorFleet.stop(stableID: stableID)
        if GatewayStableIdentifier.matches(self.pendingConnectionStableID, stableID) ||
            GatewayStableIdentifier.matches(self.preconnectRetryContext?.stableID, stableID)
        {
            let cancellationLease = self.cancelPendingConnectionAttempts()
            self.releaseAutoConnectSuppression(after: cancellationLease)
        }
        let shouldDisconnect = GatewayStableIdentifier.matches(
            self.appModel?.activeGatewayConnectConfig?.effectiveStableID,
            stableID) || GatewayStableIdentifier.matches(self.appModel?.connectedGatewayID, stableID)
        if shouldDisconnect {
            let hasDifferentPendingTarget = self.pendingConnectionStableID.map {
                !GatewayStableIdentifier.matches($0, stableID)
            } ?? false
            self.appModel?.disconnectForgottenGateway(
                preservingPendingConnectAttempt: hasDifferentPendingTarget)
        }
        if shouldDisconnect, let appModel = self.appModel {
            await appModel.waitForGatewaySessionResetIfNeeded()
        }
        // Stage before touching pairing metadata. A crash is reconciled from
        // the registry: still registered cancels, absent commits the erasure.
        guard let appModel,
              await appModel.stageChatOfflineDataRemoval(gatewayID: stableID)
        else {
            return false
        }
        guard GatewaySettingsStore.removeGatewayRegistryEntry(stableID: stableID) else {
            appModel.cancelChatOfflineDataRemoval(gatewayID: stableID)
            return false
        }
        // Discovery can schedule another reconcile while the offline-data stage awaits.
        // Invalidate its captured registry before erasing credentials, then stop any runtime
        // it recreated from the pre-commit gateway entry.
        self.cancelOperatorFleetReconcile()
        self.operatorFleet.stop(stableID: stableID)
        // Registry removal is the cross-owner commit point. Clear controller
        // artifacts before database cleanup, which may fail or be recovered on
        // a later foreground after the registry row is already gone.
        let instanceID = GatewaySettingsStore.currentInstanceID()
        self.clearLegacyManualGatewayDefaults(matching: stableID)
        GatewaySettingsStore.clearLegacyGatewaySelectors(stableID: stableID)
        GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID, stableID: stableID)
        _ = GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: stableID)
        _ = GatewayTLSStore.clearFingerprint(stableID: stableID)
        GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: nil)
        let shareRelayGatewayID = ShareGatewayRelaySettings.loadConfig()?.gatewayStableID
        if GatewayStableIdentifier.matches(shareRelayGatewayID, stableID) {
            ShareGatewayRelaySettings.clearConfig()
        }

        Self.clearDeviceAuthTokens(gatewayID: stableID)
        _ = appModel.commitChatOfflineDataRemoval(gatewayID: stableID)
        return true
    }

    func hasPendingForgetCleanup(stableID: String) -> Bool {
        GatewayStableIdentifier.key(stableID).map { self.pendingForgetCleanups[$0] != nil } ?? false
    }

    private func waitForPendingForgetCleanup(stableID: String) async {
        guard let stableIDKey = GatewayStableIdentifier.key(stableID),
              let pending = self.pendingForgetCleanups[stableIDKey]
        else { return }
        _ = await pending.task.value
        if self.pendingForgetCleanups[stableIDKey]?.id == pending.id {
            self.pendingForgetCleanups[stableIDKey] = nil
            scheduleOperatorFleetReconcile()
        }
    }

    private func persistActiveGateway(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> Bool {
        guard GatewaySettingsStore.upsertGatewayRegistryEntry(entry, activate: true) else {
            self.appModel?.gatewayStatusText = "Could not save paired gateway"
            return false
        }
        return true
    }

    func clearPendingTrustPrompt() {
        // Invalidate an in-flight probe so its late result cannot restore a stale prompt.
        self.trustProbeGeneration &+= 1
        self.pendingTrustPrompt = nil
        self.pendingTrustConnect = nil
        self.pendingConnectionStableID = nil
    }

    @discardableResult
    func cancelPendingConnectionAttempts(
        suspendCurrentGateway: Bool = false) -> AutoConnectSuppressionLease
    {
        let lease = self.beginAutoConnectSuppression(restoresAutoReconnect: suspendCurrentGateway)
        self.appModel?.cancelGatewayPreconnectVerification()
        _ = self.reserveGatewayConnectAttempt()
        if suspendCurrentGateway {
            self.appModel?.suspendGatewayForTargetReview()
        }
        return lease
    }

    private func beginAutoConnectSuppression(restoresAutoReconnect: Bool) -> AutoConnectSuppressionLease {
        let lease = AutoConnectSuppressionLease(
            generation: self.connectAttemptGeneration &+ 1,
            previousAutoReconnectEnabled: self.autoConnectSuppression?.previousAutoReconnectEnabled ??
                self.appModel?.gatewayAutoReconnectEnabled ?? false,
            restoresAutoReconnect: self.autoConnectSuppression?.restoresAutoReconnect == true || restoresAutoReconnect,
            suspendedConfig: self.autoConnectSuppression?.suspendedConfig ??
                (restoresAutoReconnect ? self.appModel?.activeGatewayConnectConfig : nil))
        self.connectAttemptGeneration &+= 1
        self.preconnectRetryContext = nil
        self.autoConnectSuppression = lease
        self.clearPendingTrustPrompt()
        return lease
    }

    func resumeAutoConnect(after lease: AutoConnectSuppressionLease) {
        // A dismissed older target must not release suppression owned by its replacement.
        guard self.autoConnectSuppression?.generation == lease.generation else { return }
        self.clearAutoConnectSuppression(generation: lease.generation)
        if lease.restoresAutoReconnect {
            let currentPreference = UserDefaults.standard.bool(forKey: "gateway.autoconnect")
            if lease.previousAutoReconnectEnabled,
               currentPreference,
               let suspendedConfig = lease.suspendedConfig
            {
                self.appModel?.resumeGatewayAfterTargetReview(suspendedConfig)
                return
            }
            self.appModel?.gatewayAutoReconnectEnabled = lease.previousAutoReconnectEnabled && currentPreference
        }
        self.attemptAutoReconnectIfNeeded()
    }

    func releaseAutoConnectSuppression(after lease: AutoConnectSuppressionLease) {
        self.clearAutoConnectSuppression(generation: lease.generation)
    }

    private func clearAutoConnectSuppression(generation: UInt64) {
        guard self.autoConnectSuppression?.generation == generation else { return }
        self.autoConnectSuppression = nil
    }

    func acceptPendingTrustPrompt(_ expectedPrompt: TrustPrompt?) async {
        guard let pending = self.pendingTrustConnect,
              let prompt = self.pendingTrustPrompt,
              prompt == expectedPrompt,
              GatewayStableIdentifier.matches(pending.stableID, prompt.stableID)
        else { return }

        guard !Task.isCancelled,
              pending.suppressionLease.generation == self.connectAttemptGeneration,
              pending.gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else {
            // Only retire this prompt's state. A newer attempt owns its own suppression.
            if self.pendingTrustConnect?.suppressionLease.generation == pending.suppressionLease.generation {
                self.clearPendingTrustPrompt()
            }
            self.clearAutoConnectSuppression(generation: pending.suppressionLease.generation)
            return
        }

        guard self.persistTLSFingerprint(prompt.fingerprintSha256, pending.stableID) else {
            self.appModel?.gatewayStatusText = "Could not save gateway certificate"
            return
        }

        let instanceId = GatewaySettingsStore.currentInstanceID()
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: pending.stableID,
            kind: pending.isManual ? .manual : .discovered,
            name: prompt.gatewayName,
            host: pending.isManual ? prompt.host : nil,
            port: pending.isManual ? prompt.port : nil,
            useTLS: true,
            contextPath: pending.isManual
                ? URLComponents(url: pending.url, resolvingAgainstBaseURL: false)?.percentEncodedPath
                : nil,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else {
            _ = GatewayTLSStore.clearFingerprint(stableID: pending.stableID)
            return
        }
        self.clearPendingTrustPrompt()
        if pending.isManual {
            // The prompt owned the attempt during review. Restore its unconsumed setup
            // receipt for failures before handoff, rather than reloading expiry-free credentials.
            self.preconnectRetryContext = PreconnectRetryContext(
                target: .manual(
                    host: prompt.host,
                    port: prompt.port,
                    useTLS: true,
                    contextPath: registryEntry.contextPath,
                    authOverride: pending.authOverride),
                stableID: pending.stableID,
                attemptGeneration: pending.suppressionLease.generation,
                gatewayGeneration: pending.gatewayGeneration)
        }
        let storedCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: pending.stableID)
        let token = pending.authOverride.map(\.token) ?? storedCredentials.token
        let bootstrapToken = pending.authOverride.map(\.bootstrapToken) ?? storedCredentials.bootstrapToken
        let password = pending.authOverride.map(\.password) ?? storedCredentials.password
        let suppressStoredDeviceAuth =
            pending.authOverride?.suppressStoredDeviceAuth ?? storedCredentials.suppressStoredDeviceAuth
        let tlsParams = GatewayTLSParams(
            required: true,
            expectedFingerprint: prompt.fingerprintSha256,
            allowTOFU: false,
            storeKey: pending.stableID)

        self.didAutoConnect = true
        let didStart = self.startAutoConnect(
            url: pending.url,
            gatewayStableID: pending.stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            allowStoredDeviceAuth: pending.allowStoredDeviceAuth && !suppressStoredDeviceAuth,
            suppressionGeneration: pending.suppressionLease.generation,
            expectedGeneration: pending.gatewayGeneration,
            admissionCheckpoint: pending.admissionCheckpoint,
            authOverride: pending.authOverride,
            userInitiated: pending.userInitiated)
        if !didStart {
            self.clearAutoConnectSuppression(generation: pending.suppressionLease.generation)
        }
    }

    func declinePendingTrustPrompt(_ expectedPrompt: TrustPrompt?) {
        guard let expectedPrompt,
              let pending = self.pendingTrustConnect,
              self.pendingTrustPrompt == expectedPrompt
        else { return }
        guard pending.suppressionLease.generation == self.connectAttemptGeneration,
              pending.gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else {
            self.clearPendingTrustPrompt()
            self.clearAutoConnectSuppression(generation: pending.suppressionLease.generation)
            return
        }
        let lease = self.cancelPendingConnectionAttempts()
        self.appModel?.gatewayStatusText = "Offline"
        if lease.restoresAutoReconnect {
            self.resumeAutoConnect(after: lease)
        } else {
            self.releaseAutoConnectSuppression(after: lease)
        }
    }

    @discardableResult
    func trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem) async -> Bool {
        let admissionCheckpoint = self.ingress.admissionCheckpoint()
        guard problem.canTrustRotatedCertificate,
              let stableID = problem.tlsStoreKey,
              let fingerprint = problem.tlsObservedFingerprint
        else {
            self.appModel?.gatewayStatusText = "Certificate review required"
            return false
        }

        guard self.persistTLSFingerprint(fingerprint, stableID) else {
            self.appModel?.gatewayStatusText = "Could not update gateway certificate"
            return false
        }

        GatewayDiagnostics.log(
            "gateway tls pin replaced stableID=\(stableID) "
                + "old=\(problem.tlsExpectedFingerprint ?? "unknown") new=\(fingerprint)")
        appModel?.gatewayStatusText = "Gateway certificate updated. Reconnecting…"
        if let retry = self.currentPreconnectRetry,
           GatewayStableIdentifier.matches(retry.stableID, stableID)
        {
            return await self.retryPreconnect(retry) == .accepted
        }
        if let appModel, let cfg = appModel.activeGatewayConnectConfig,
           GatewayStableIdentifier.matches(cfg.tls?.storeKey ?? cfg.stableID, stableID)
        {
            let currentTLS = cfg.tls
            var refreshedConfig = cfg
            refreshedConfig.tls = GatewayTLSParams(
                required: currentTLS?.required ?? true,
                expectedFingerprint: fingerprint,
                allowTOFU: currentTLS?.allowTOFU ?? false,
                storeKey: currentTLS?.storeKey ?? stableID)
            let generation = appModel.gatewayConnectGeneration
            guard !Task.isCancelled, !self.hasPendingForgetCleanup(stableID: cfg.stableID) else { return false }
            do {
                let authorization = try await ingress.prepare(
                    route: .init(url: cfg.url, stableID: cfg.stableID, tls: refreshedConfig.tls),
                    userInitiated: false,
                    admissionCheckpoint: admissionCheckpoint)
                guard !Task.isCancelled, generation == appModel.gatewayConnectGeneration,
                      !self.hasPendingForgetCleanup(stableID: cfg.stableID)
                else { return false }
                refreshedConfig.ingressAuthorization = authorization
                appModel.applyGatewayConnectConfig(refreshedConfig, expectedGeneration: generation)
            } catch {
                self.failGatewayIngressPreparation(
                    error, stableID: cfg.stableID, url: cfg.url, expectedGeneration: generation)
                return false
            }
        } else {
            guard GatewayStableIdentifier.matches(GatewaySettingsStore.activeGatewayEntry()?.stableID, stableID)
            else { return false }
            return await self.connectActiveGateway() == .accepted
        }
        return true
    }
}

extension GatewayConnectionController {
    private func updateFromDiscovery(allowAutoConnect: Bool = true) {
        let newGateways = self.discovery.gateways
        self.gateways = newGateways
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredGateway(from: newGateways)
        self.scheduleOperatorFleetReconcile()
        if allowAutoConnect {
            self.maybeAutoConnect()
        }
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.gateways
            _ = self.discovery.statusText
            _ = self.discovery.debugLog
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateFromDiscovery()
                self.observeDiscovery()
            }
        }
    }

    private func maybeAutoConnect() {
        guard self.autoConnectSuppression == nil else { return }
        guard !self.didAutoConnect else { return }
        guard let appModel else { return }
        guard appModel.gatewayServerName == nil else { return }

        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "gateway.autoconnect") else { return }

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        if let active = GatewaySettingsStore.activeGatewayEntry() {
            if self.startActiveGatewayAutoConnect(active, instanceId: instanceId) {
                return
            }
            if active.kind == .discovered,
               let target = self.gateways.first(where: {
                   GatewayStableIdentifier.matches($0.stableID, active.stableID)
               }),
               GatewayTLSStore.loadFingerprint(stableID: target.stableID) != nil
            {
                self.didAutoConnect = true
                let admissionCheckpoint = self.ingress.admissionCheckpoint()
                Task { [weak self] in
                    guard let self else { return }
                    _ = await self.connectDiscoveredGateway(
                        target,
                        userInitiated: false,
                        admissionCheckpoint: admissionCheckpoint)
                }
                return
            }
            if active.kind == .discovered,
               let fallback = self.mostRecentlyConnectedManualGateway(),
               self.startActiveGatewayAutoConnect(fallback, instanceId: instanceId)
            {
                _ = GatewaySettingsStore.setActiveGateway(stableID: fallback.stableID)
                return
            }
            return
        }

        if defaults.bool(forKey: "gateway.manual.enabled") {
            self.startConfiguredManualAutoConnect(defaults: defaults, instanceId: instanceId)
            return
        }

        let preferredStableID = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.preferredStableID"))
        let lastDiscoveredStableID = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.lastDiscoveredStableID"))

        let candidates = [preferredStableID, lastDiscoveredStableID].compactMap(\.self)
        let preferredGateway = candidates.lazy.compactMap { id in
            self.gateways.first { GatewayStableIdentifier.matches($0.stableID, id) }
        }.first
        guard let gateway = preferredGateway ?? (self.gateways.count == 1 ? self.gateways.first : nil)
        else { return }
        // Autoconnect only to previously trusted gateways; discovery cannot supply a pin.
        guard GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil else { return }

        self.didAutoConnect = true
        let admissionCheckpoint = self.ingress.admissionCheckpoint()
        Task { [weak self] in
            guard let self else { return }
            _ = await self.connectDiscoveredGateway(
                gateway,
                userInitiated: false,
                admissionCheckpoint: admissionCheckpoint)
        }
    }

    private func startConfiguredManualAutoConnect(defaults: UserDefaults, instanceId: String) {
        let host = defaults.string(forKey: "gateway.manual.host")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return }

        let configuredPort = defaults.integer(forKey: "gateway.manual.port")
        guard let port = Self.resolvedManualPort(host: host, port: configuredPort) else { return }
        _ = self.startActiveGatewayAutoConnect(
            GatewaySettingsStore.GatewayRegistryEntry(
                stableID: self.manualStableID(host: host, port: port),
                kind: .manual,
                name: "\(host):\(port)",
                host: host,
                port: port,
                useTLS: defaults.bool(forKey: "gateway.manual.tls"),
                lastConnectedAtMs: nil),
            instanceId: instanceId,
            persistSelection: true)
    }

    private func startActiveGatewayAutoConnect(
        _ active: GatewaySettingsStore.GatewayRegistryEntry,
        instanceId: String,
        persistSelection: Bool = false) -> Bool
    {
        guard active.kind == .manual,
              let host = active.host, let port = active.port,
              let route = self.manualGatewayRoute(
                  host: host,
                  port: port,
                  useTLS: active.useTLS,
                  stableID: active.stableID,
                  contextPath: active.contextPath)
        else { return false }
        if persistSelection {
            // Preflight and automatic retry must observe the selected profile with the same
            // resolved TLS policy as the route, including an existing pin or Tailnet HTTPS.
            var selected = active
            selected.useTLS = route.tls?.required == true
            guard self.persistActiveGateway(selected) else { return false }
        }
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: active.stableID)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: route.url,
            gatewayStableID: active.stableID,
            tls: route.tls,
            token: credentials.token,
            bootstrapToken: credentials.bootstrapToken,
            password: credentials.password,
            allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth)
        return true
    }

    private func attemptAutoReconnectIfNeeded() {
        guard let appModel else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        guard self.autoConnectSuppression == nil else { return }
        // Avoid starting duplicate connect loops while a prior config is active.
        guard appModel.activeGatewayConnectConfig == nil else { return }
        guard UserDefaults.standard.bool(forKey: "gateway.autoconnect") else { return }
        self.didAutoConnect = false
        self.maybeAutoConnect()
    }

    @discardableResult
    private func startAutoConnect(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        allowStoredDeviceAuth: Bool = true,
        forceReconnect: Bool = false,
        suppressionGeneration: UInt64? = nil,
        expectedGeneration: UInt64? = nil,
        admissionCheckpoint: UInt64? = nil,
        authOverride: ManualAuthOverride? = nil,
        userInitiated: Bool = false) -> Bool
    {
        guard let appModel,
              let gatewayStableID = GatewayStableIdentifier.exact(gatewayStableID),
              !self.hasPendingForgetCleanup(stableID: gatewayStableID)
        else { return false }
        if let expectedGeneration {
            guard expectedGeneration == appModel.gatewayConnectGeneration else { return false }
        }
        let admissionCheckpoint = admissionCheckpoint ?? self.ingress.admissionCheckpoint()
        let automaticGateway = userInitiated ? nil : GatewaySettingsStore.loadGatewayRegistry().entries.first {
            GatewayStableIdentifier.matches($0.stableID, gatewayStableID)
        }
        let instanceID = UserDefaults.standard.string(forKey: "node.instanceId") ?? ""
        let previousTask = self.pendingAutoConnectTask
        previousTask?.cancel()
        // Advancing again at handoff rejects work that captured the reservation generation while
        // endpoint resolution or trust verification was suspended.
        let previousGeneration = appModel.gatewayConnectGeneration
        let generation = appModel.beginGatewayConnectAttempt()
        if let retry = preconnectRetryContext,
           GatewayStableIdentifier.matches(retry.stableID, gatewayStableID)
        {
            self.preconnectRetryContext = PreconnectRetryContext(
                target: retry.target,
                stableID: retry.stableID,
                attemptGeneration: retry.attemptGeneration,
                gatewayGeneration: generation)
        }
        if self.pendingGatewayRestoration?.generation == previousGeneration {
            self.pendingGatewayRestoration?.generation = generation
            self.pendingGatewayRestoration?.replacementStableID = gatewayStableID
        } else {
            // Admission owns recovery before reset starts; task completion must not decide
            // whether a later cancellation still owes the old route a restart.
            self.pendingGatewayRestoration = appModel.activeGatewayConnectConfig.map {
                GatewayRestoration(config: $0, generation: generation, replacementStableID: gatewayStableID)
            }
        }
        self.pendingAutoConnectGeneration = generation
        self.pendingConnectionStableID = gatewayStableID
        // An explicit target owns suppression until its queued handoff exits. Otherwise a
        // foreground reconnect can replace it while reset or permission work is suspended.
        self.pendingAutoConnectSuppressionGeneration = suppressionGeneration
        appModel.setGatewayConnectionProgress(reconnecting: false)
        let task = Task { [weak self, weak appModel] in
            guard let self, let appModel else { return }
            @MainActor func isCurrent() -> Bool {
                !Task.isCancelled && generation == appModel.gatewayConnectGeneration &&
                    !self.hasPendingForgetCleanup(stableID: gatewayStableID)
            }
            @MainActor func canRetryAutomatically() -> Bool {
                guard !userInitiated, isCurrent(),
                      appModel.activeGatewayConnectConfig == nil,
                      appModel.gatewayAutoReconnectEnabled,
                      UserDefaults.standard.bool(forKey: "gateway.autoconnect"),
                      UserDefaults.standard.string(forKey: "node.instanceId") == instanceID,
                      let automaticGateway, let active = GatewaySettingsStore.activeGatewayEntry(),
                      active.id == automaticGateway.id, active.kind == automaticGateway.kind,
                      active.host == automaticGateway.host, active.port == automaticGateway.port,
                      active.useTLS == automaticGateway.useTLS, active.contextPath == automaticGateway.contextPath
                else { return false }
                let credentials = GatewaySettingsStore.loadGatewayCredentials(
                    instanceId: instanceID, gatewayStableID: gatewayStableID)
                return credentials.token == token && credentials.bootstrapToken == bootstrapToken &&
                    credentials.password == password && credentials
                    .suppressStoredDeviceAuth == !allowStoredDeviceAuth &&
                    GatewayTLSStore.loadFingerprint(stableID: gatewayStableID) == tls?.expectedFingerprint
            }
            defer {
                if self.pendingAutoConnectGeneration == generation {
                    self.pendingAutoConnectTask = nil
                    self.pendingAutoConnectGeneration = nil
                    self.pendingAutoConnectSuppressionGeneration = nil
                    if GatewayStableIdentifier.matches(self.pendingConnectionStableID, gatewayStableID) {
                        self.pendingConnectionStableID = nil
                    }
                }
                if let suppressionGeneration,
                   self.autoConnectSuppression?.generation == suppressionGeneration
                {
                    self.clearAutoConnectSuppression(generation: suppressionGeneration)
                }
            }
            await previousTask?.value
            await appModel.waitForGatewaySessionResetIfNeeded()
            guard isCurrent() else { return }
            var retriedAutomatically = false
            do {
                let ingressAuthorization = try await self.prepareGatewayIngress(
                    route: .init(url: url, stableID: gatewayStableID, tls: tls),
                    userInitiated: userInitiated,
                    admissionCheckpoint: admissionCheckpoint,
                    canRetry: {
                        guard canRetryAutomatically() else { return false }
                        retriedAutomatically = true
                        return true
                    })
                guard isCurrent(), !retriedAutomatically || canRetryAutomatically() else { return }
                guard self.admitSetupLifetime(authOverride, stableID: gatewayStableID, generation: generation)
                else { return }
                if forceReconnect {
                    await self.forceReconnectReset(appModel)
                    guard isCurrent(), !retriedAutomatically || canRetryAutomatically() else { return }
                }
                let nodeOptions = await self.makeConnectOptions(
                    deviceAuthGatewayID: GatewaySettingsStore.authenticationOwnerID(routeStableID: gatewayStableID),
                    allowStoredDeviceAuth: allowStoredDeviceAuth)
                // Permission reads above can suspend long enough for a model-owned reconnect reset
                // to start, so close the reset barrier again immediately before the synchronous apply.
                await appModel.waitForGatewaySessionResetIfNeeded()
                guard isCurrent(), !retriedAutomatically || canRetryAutomatically() else { return }
                guard self.admitSetupLifetime(authOverride, stableID: gatewayStableID, generation: generation)
                else { return }
                guard ingressAuthorization?.isCurrent() != false else { throw GatewayExternalAuthorizationError() }
                let cfg = GatewayConnectConfig(
                    url: url,
                    stableID: gatewayStableID,
                    tls: tls,
                    token: token,
                    bootstrapToken: bootstrapToken,
                    password: password,
                    nodeOptions: nodeOptions,
                    ingressAuthorization: ingressAuthorization)
                // Only the actual Gateway handoff consumes this receipt. Browser and TLS
                // waits must retain it so retries cannot outlive the original setup code.
                authOverride?.markHandedOff()
                self.preconnectRetryContext = nil
                self.pendingGatewayRestoration = nil
                appModel.applyGatewayConnectConfig(
                    cfg,
                    forceReconnect: forceReconnect,
                    expectedGeneration: generation)
                self.scheduleOperatorFleetReconcile()
            } catch {
                guard isCurrent(), !retriedAutomatically || canRetryAutomatically() else { return }
                self.failGatewayIngressPreparation(
                    error, stableID: gatewayStableID, url: url, expectedGeneration: generation)
            }
        }
        self.pendingAutoConnectTask = task
        return true
    }

    private func probeTLSFingerprint(
        host: String,
        port: Int,
        url: URL,
        queueLabel: String) async -> GatewayTLSFingerprintProbeResult?
    {
        self.trustProbeGeneration &+= 1
        let generation = self.trustProbeGeneration
        self.pendingTrustConnect = nil
        self.pendingTrustPrompt = nil
        let reachable = await self.tcpReachabilityProbe(
            host,
            port,
            GatewayTLSFingerprintProbeBudget.tcpConnectTimeoutSeconds,
            queueLabel)
        guard !Task.isCancelled, self.trustProbeGeneration == generation else { return nil }
        guard reachable else {
            return .failure(.endpointUnreachable)
        }
        let result = await self.tlsFingerprintProbe(url)
        guard !Task.isCancelled, self.trustProbeGeneration == generation else { return nil }
        return result
    }

    private func resolveFirstUseTLS(
        host: String,
        port: Int,
        gatewayName: String,
        pendingConnect: GatewayPendingTrustConnect,
        isSetupCodeOrigin: Bool = false) async
        -> ConnectionAttemptResult?
    {
        self.appModel?.beginGatewayPreconnectVerification(
            stableID: pendingConnect.stableID,
            statusText: "Verifying gateway TLS fingerprint…")
        guard let probeResult = await self.probeTLSFingerprint(
            host: host,
            port: port,
            url: pendingConnect.url,
            queueLabel: pendingConnect.isManual ? "gateway.tls.manual" : "gateway.tls.discovered")
        else { return .superseded }
        guard !Task.isCancelled,
              self.connectAttemptGeneration == pendingConnect.suppressionLease.generation,
              pendingConnect.gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else { return .superseded }
        switch probeResult {
        case .systemTrusted where isSetupCodeOrigin:
            return nil
        case let .systemTrusted(fp), let .fingerprint(fp):
            // The verified attempt now belongs to the trust prompt, not the failed retry.
            self.preconnectRetryContext = nil
            self.pendingTrustConnect = pendingConnect
            self.pendingTrustPrompt = TrustPrompt(
                stableID: pendingConnect.stableID,
                gatewayName: gatewayName,
                host: host,
                port: port,
                fingerprintSha256: fp,
                isManual: pendingConnect.isManual,
                attemptGeneration: pendingConnect.suppressionLease.generation)
            self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
            return .accepted
        case let .failure(failure):
            let problem = self.tlsProbeFailureProblem(failure, host: host, port: port)
            self.appModel?.failGatewayPreconnectVerification(
                problem,
                stableID: pendingConnect.stableID,
                host: host,
                expectedGeneration: pendingConnect.gatewayGeneration)
            return .failed(problem.localizedMessage)
        }
    }

    private func beginConnectAttempt(targetStableID: String?, admissionCheckpoint: UInt64? = nil)
        -> (suppressionLease: AutoConnectSuppressionLease, gatewayGeneration: UInt64?, admissionCheckpoint: UInt64)
    {
        let admissionCheckpoint = admissionCheckpoint ?? self.ingress.admissionCheckpoint()
        let suppressionLease = self.beginAutoConnectSuppression(restoresAutoReconnect: false)
        // Allocate both tokens before any resolution or trust work. A new explicit target must
        // invalidate queued config construction from the previous target immediately.
        let gatewayGeneration = self.reserveGatewayConnectAttempt(targetStableID: targetStableID)
        return (suppressionLease, gatewayGeneration, admissionCheckpoint)
    }

    private func reserveGatewayConnectAttempt(targetStableID: String? = nil) -> UInt64? {
        let previousTask = self.pendingAutoConnectTask
        previousTask?.cancel()
        self.ingress.cancelSignIn()
        self.pendingConnectionStableID = nil
        guard let appModel else { return nil }
        let activeConfig = appModel.activeGatewayConnectConfig
        let inheritedRestoration = self.pendingGatewayRestoration.map {
            $0.generation == appModel.gatewayConnectGeneration &&
                activeConfig?.hasSameConnectionInputs(as: $0.config) == true
        } == true
        let generation = appModel.beginGatewayConnectAttempt()
        let shouldRestoreActiveConfig = appModel.gatewayAutoReconnectEnabled &&
            !appModel.gatewayPairingPaused &&
            appModel.lastGatewayProblem?.pauseReconnect != true &&
            (inheritedRestoration || appModel.hasGatewaySessionResetInFlight)
        self.pendingGatewayRestoration = if shouldRestoreActiveConfig, let activeConfig {
            GatewayRestoration(config: activeConfig, generation: generation, replacementStableID: targetStableID)
        } else {
            nil
        }
        self.pendingAutoConnectSuppressionGeneration = nil
        self.pendingAutoConnectGeneration = generation
        // The barrier owns any superseded teardown until it finishes. If the replacement never
        // reaches handoff, restore the still-current route after that teardown completes.
        let barrier = Task { [weak self, weak appModel] in
            guard let self, let appModel else { return }
            defer {
                if self.pendingAutoConnectGeneration == generation {
                    self.pendingAutoConnectTask = nil
                    self.pendingAutoConnectGeneration = nil
                }
            }
            await previousTask?.value
            await appModel.waitForGatewaySessionResetIfNeeded()
            guard !Task.isCancelled,
                  generation == appModel.gatewayConnectGeneration,
                  let restoration = self.pendingGatewayRestoration,
                  restoration.generation == generation,
                  appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: restoration.config) == true
            else { return }
            // Keep the recovery entitlement after this task finishes. A later Cancel still
            // owes the old route a restart; only replacement commit or recovery consumes it.
            if GatewayStableIdentifier.matches(
                restoration.replacementStableID,
                appModel.unresolvedGatewayPreconnectStableID)
            {
                return
            }
            guard appModel.gatewayAutoReconnectEnabled,
                  !appModel.gatewayPairingPaused,
                  appModel.lastGatewayProblem?.pauseReconnect != true
            else { return }
            self.pendingGatewayRestoration = nil
            appModel.applyGatewayConnectConfig(restoration.config, expectedGeneration: generation)
        }
        self.pendingAutoConnectTask = barrier
        return generation
    }

    private func finishConnectAttempt(_ lease: AutoConnectSuppressionLease) {
        guard self.connectAttemptGeneration == lease.generation else { return }
        guard self.pendingTrustPrompt == nil else { return }
        guard self.pendingAutoConnectSuppressionGeneration != lease.generation else { return }
        self.pendingConnectionStableID = nil
        if lease.restoresAutoReconnect {
            self.resumeAutoConnect(after: lease)
        } else {
            self.releaseAutoConnectSuppression(after: lease)
        }
    }

    func resolveServiceEndpoint(_ endpoint: NWEndpoint) async -> (host: String, port: Int)? {
        if let serviceEndpointResolver {
            return await serviceEndpointResolver(endpoint)
        }
        guard case let .service(name, type, domain, _) = endpoint else { return nil }
        let key = "\(domain)|\(type)|\(name)"
        return await withCheckedContinuation { continuation in
            let resolver = BonjourServiceResolver(
                name: name,
                type: type,
                domain: domain,
                resolve: { service -> (host: String, port: Int)? in
                    guard let host = BonjourServiceResolverSupport.normalizeHost(service.hostName),
                          !host.isEmpty, service.port > 0 else { return nil }
                    return (host: host, port: service.port)
                },
                completion: { [weak self] result in
                    Task { @MainActor in
                        self?.pendingServiceResolvers[key] = nil
                        continuation.resume(returning: result)
                    }
                })
            self.pendingServiceResolvers[key] = resolver
            resolver.start()
        }
    }
}

extension GatewayConnectionController {
    private func verifySetupFingerprint(
        _ expectedFingerprint: String?,
        host: String,
        port: Int,
        contextPath: String?,
        stableID: String,
        attemptGeneration: UInt64,
        gatewayGeneration: UInt64?) async -> ConnectionAttemptResult?
    {
        guard let expectedFingerprint else { return nil }
        guard let url = self.buildGatewayURL(
            host: host,
            port: port,
            useTLS: true,
            contextPath: contextPath)
        else { return .failed(String(localized: "Failed to build the gateway URL.")) }
        self.appModel?.beginGatewayPreconnectVerification(
            stableID: stableID,
            statusText: "Verifying gateway TLS fingerprint…")
        guard let probeResult = await self.probeTLSFingerprint(
            host: host,
            port: port,
            url: url,
            queueLabel: "gateway.tls.setup")
        else { return .superseded }
        guard !Task.isCancelled,
              self.connectAttemptGeneration == attemptGeneration,
              gatewayGeneration == self.appModel?.gatewayConnectGeneration
        else { return .superseded }
        let problem: GatewayConnectionProblem
        switch probeResult {
        case let .systemTrusted(observedFingerprint), let .fingerprint(observedFingerprint):
            if observedFingerprint == expectedFingerprint { return nil }
            // A setup-code pin is authority, not a rotation suggestion. Do not offer to trust
            // a different observed certificate or attach transport recovery advice.
            problem = GatewayConnectionProblem(
                kind: .tlsPinMismatch,
                owner: .network,
                title: "Gateway certificate mismatch",
                message: "Gateway certificate does not match setup code.",
                actionLabel: "Retry",
                retryable: true,
                pauseReconnect: true)
        case let .failure(failure):
            problem = self.tlsProbeFailureProblem(failure, host: host, port: port)
        }
        self.appModel?.failGatewayPreconnectVerification(
            problem,
            stableID: stableID,
            host: host,
            expectedGeneration: gatewayGeneration)
        return .failed(problem.localizedMessage)
    }

    private func restoreStoredFingerprint(
        _ storedFingerprint: String?,
        afterAttempting setupFingerprint: String?,
        stableID: String)
    {
        guard setupFingerprint != nil, setupFingerprint != storedFingerprint else { return }
        if let storedFingerprint {
            _ = self.persistTLSFingerprint(storedFingerprint, stableID)
        } else {
            _ = GatewayTLSStore.clearFingerprint(stableID: stableID)
        }
    }
}

#if DEBUG
extension GatewayConnectionController {
    func _test_pendingAutoConnectState() -> (generation: UInt64?, pending: Bool) {
        (self.pendingAutoConnectGeneration, self.pendingAutoConnectTask != nil)
    }

    func _test_setGateways(_ gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        self.gateways = gateways
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }

    func _test_triggerAutoReconnect() {
        self.attemptAutoReconnectIfNeeded()
    }

    func _test_didAutoConnect() -> Bool {
        self.didAutoConnect
    }

    func _test_isAutoConnectSuppressed() -> Bool {
        self.autoConnectSuppression != nil
    }

    func _test_hasOperatorFleetReconcileTask() -> Bool {
        self.operatorFleetReconcileTask != nil
    }

    func _test_resolveManualPort(host: String, port: Int, useTLS _: Bool) -> Int? {
        Self.resolvedManualPort(host: host, port: port)
    }
}
#endif
