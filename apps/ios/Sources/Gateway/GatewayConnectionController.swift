import AVFoundation
import Contacts
import CoreLocation
import CoreMotion
import CryptoKit
import EventKit
import Foundation
import Network
import Observation
import OpenClawKit
import os
import Photos
import ReplayKit
import Security
import Speech
import SwiftUI
import UIKit

@MainActor
@Observable
final class GatewayConnectionController {
    struct ManualAuthOverride: Equatable {
        struct SetupAuth {
            let token: String
            let bootstrapToken: String
            let password: String

            var hasBootstrapToken: Bool {
                !self.bootstrapToken.isEmpty
            }

            var shouldApplyTokenField: Bool {
                !self.token.isEmpty || self.hasBootstrapToken
            }

            var shouldApplyPasswordField: Bool {
                !self.password.isEmpty || self.hasBootstrapToken
            }

            var manualAuthOverride: ManualAuthOverride? {
                ManualAuthOverride.normalized(
                    token: self.token,
                    bootstrapToken: self.bootstrapToken,
                    password: self.password)
            }
        }

        let token: String?
        let bootstrapToken: String?
        let password: String?

        static func explicit(
            token: String?,
            bootstrapToken: String?,
            password: String?) -> ManualAuthOverride
        {
            let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let trimmedBootstrapToken = bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return ManualAuthOverride(
                token: trimmedToken.isEmpty ? nil : trimmedToken,
                bootstrapToken: trimmedBootstrapToken.isEmpty ? nil : trimmedBootstrapToken,
                password: trimmedPassword.isEmpty ? nil : trimmedPassword)
        }

        static func normalized(
            token: String?,
            bootstrapToken: String?,
            password: String?) -> ManualAuthOverride?
        {
            let override = ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password)
            guard override.token != nil || override.bootstrapToken != nil || override.password != nil
            else { return nil }
            return override
        }

        static func currentManualInput(
            token: String?,
            pendingOverride: ManualAuthOverride?,
            password: String?) -> ManualAuthOverride?
        {
            guard let pendingOverride else {
                return ManualAuthOverride.normalized(token: token, bootstrapToken: nil, password: password)
            }
            return ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: pendingOverride.bootstrapToken,
                password: password)
        }

        static func setupAuth(from link: GatewayConnectDeepLink) -> SetupAuth {
            SetupAuth(
                token: link.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                bootstrapToken: link.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                password: link.password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        }
    }

    private struct PendingTrustConnect {
        let url: URL
        let stableID: String
        let isManual: Bool
        let authOverride: ManualAuthOverride?
    }

    struct TrustPrompt: Identifiable, Equatable {
        let stableID: String
        let gatewayName: String
        let host: String
        let port: Int
        let fingerprintSha256: String
        let isManual: Bool

        var id: String {
            self.stableID
        }
    }

    private(set) var gateways: [GatewayDiscoveryModel.DiscoveredGateway] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [GatewayDiscoveryModel.DebugLogEntry] = []
    private(set) var pendingTrustPrompt: TrustPrompt?

    private let discovery = GatewayDiscoveryModel()
    private let discoveryEnabled: Bool
    private weak var appModel: NodeAppModel?
    private var localNetworkAccessRequested: Bool
    private var currentScenePhase: ScenePhase = .inactive
    private var didAutoConnect = false
    private var pendingServiceResolvers: [String: GatewayServiceResolver] = [:]
    private var pendingTrustConnect: PendingTrustConnect?

    private struct SavedManualEndpoint: Equatable {
        let host: String
        let port: Int
        let useTLS: Bool
    }

    init(
        appModel: NodeAppModel,
        startDiscovery: Bool = true,
        deferDiscoveryUntilLocalNetworkRequest: Bool = false)
    {
        self.discoveryEnabled = startDiscovery
        self.appModel = appModel
        self.localNetworkAccessRequested = !deferDiscoveryUntilLocalNetworkRequest

        GatewaySettingsStore.bootstrapPersistence()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "gateway.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if self.discoveryEnabled, self.localNetworkAccessRequested {
            self.discovery.start()
        }
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func requestLocalNetworkAccess(reason: String) {
        guard self.discoveryEnabled else {
            self.discovery.stop()
            self.updateFromDiscovery()
            return
        }

        self.localNetworkAccessRequested = true
        GatewayDiagnostics.log("local network access requested reason=\(reason)")

        guard self.currentScenePhase != .background else { return }
        self.discovery.start()
        self.updateFromDiscovery()
        self.attemptAutoReconnectIfNeeded()
    }

    func setScenePhase(_ phase: ScenePhase) {
        self.currentScenePhase = phase
        guard self.discoveryEnabled else {
            self.discovery.stop()
            return
        }
        guard self.localNetworkAccessRequested else { return }

        switch phase {
        case .background:
            self.discovery.stop()
        case .active, .inactive:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        @unknown default:
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

    /// Returns `nil` when a connect attempt was started, otherwise returns a user-facing error.
    func connectWithDiagnostics(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async -> String? {
        await self.connectDiscoveredGateway(gateway)
    }

    private func connectDiscoveredGateway(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway,
        forceReconnect: Bool = false) async -> String?
    {
        self.requestLocalNetworkAccess(reason: "connect_discovered_gateway")
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if instanceId.isEmpty {
            return "Missing instanceId (node.instanceId). Try restarting the app."
        }
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)

        // Resolve the service endpoint (SRV/A/AAAA). TXT is unauthenticated; do not route via TXT.
        guard let target = await self.resolveServiceEndpoint(gateway.endpoint) else {
            return "Failed to resolve the discovered gateway endpoint."
        }

        let stableID = gateway.stableID
        // Discovery is a LAN operation; refuse unauthenticated plaintext connects.
        let tlsRequired = true
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        guard gateway.tlsEnabled || stored != nil else {
            return "Discovered gateway is missing TLS and no trusted fingerprint is stored."
        }

        if tlsRequired, stored == nil {
            guard let url = self.buildGatewayURL(host: target.host, port: target.port, useTLS: true)
            else { return "Failed to build TLS URL for trust verification." }
            guard let fp = await self.probeTLSFingerprint(url: url) else {
                return "Failed to read TLS fingerprint from discovered gateway."
            }
            self.pendingTrustConnect = PendingTrustConnect(
                url: url,
                stableID: stableID,
                isManual: false,
                authOverride: nil)
            self.pendingTrustPrompt = TrustPrompt(
                stableID: stableID,
                gatewayName: gateway.name,
                host: target.host,
                port: target.port,
                fingerprintSha256: fp,
                isManual: false)
            self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
            return nil
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }

        guard let url = self.buildGatewayURL(
            host: target.host,
            port: target.port,
            useTLS: tlsParams?.required == true)
        else { return "Failed to build discovered gateway URL." }
        GatewaySettingsStore.saveLastGatewayConnectionDiscovered(stableID: stableID, useTLS: true)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            forceReconnect: forceReconnect)
        return nil
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        _ = await self.connectWithDiagnostics(gateway)
    }

    func connectManual(
        host: String,
        port: Int,
        useTLS: Bool,
        authOverride: ManualAuthOverride? = nil,
        forceReconnect: Bool = false) async
    {
        self.requestLocalNetworkAccess(reason: "connect_manual")
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let token =
            authOverride.map(\.token) ?? GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken =
            authOverride.map(\.bootstrapToken) ?? GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password =
            authOverride.map(\.password) ?? GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let pendingAuthOverride = authOverride ?? ManualAuthOverride.normalized(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
        let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
        guard let resolvedPort = self.resolveManualPort(host: host, port: port, useTLS: resolvedUseTLS)
        else { return }
        let stableID = self.manualStableID(host: host, port: resolvedPort)
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if resolvedUseTLS, stored == nil {
            guard let url = self.buildGatewayURL(host: host, port: resolvedPort, useTLS: true) else { return }
            guard let fp = await self.probeTLSFingerprint(url: url) else {
                self.appModel?.gatewayStatusText =
                    "TLS handshake failed for \(host):\(resolvedPort). "
                        + "Remote gateways must use HTTPS/WSS."
                return
            }
            self.pendingTrustConnect = PendingTrustConnect(
                url: url,
                stableID: stableID,
                isManual: true,
                authOverride: pendingAuthOverride)
            self.pendingTrustPrompt = TrustPrompt(
                stableID: stableID,
                gatewayName: "\(host):\(resolvedPort)",
                host: host,
                port: resolvedPort,
                fingerprintSha256: fp,
                isManual: true)
            self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
            return
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }
        guard let url = self.buildGatewayURL(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true)
        else { return }
        GatewaySettingsStore.saveLastGatewayConnectionManual(
            host: host,
            port: resolvedPort,
            useTLS: resolvedUseTLS && tlsParams != nil,
            stableID: stableID)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            forceReconnect: forceReconnect)
    }

    func connectLastKnown() async {
        self.requestLocalNetworkAccess(reason: "connect_last_known")
        guard let last = GatewaySettingsStore.loadLastGatewayConnection() else { return }
        switch last {
        case let .manual(host, port, useTLS, _):
            await self.connectManual(host: host, port: port, useTLS: useTLS, forceReconnect: true)
        case let .discovered(stableID, _):
            guard let gateway = self.gateways.first(where: { $0.stableID == stableID }) else {
                _ = await self.connectSavedManualEndpointFallback()
                return
            }
            _ = await self.connectDiscoveredGateway(gateway, forceReconnect: true)
        }
    }

    /// Rebuild connect options from current local settings (caps/commands/permissions)
    /// and re-apply the active gateway config so capability changes take effect immediately.
    func refreshActiveGatewayRegistrationFromSettings() {
        Task { [weak self] in
            await self?.refreshActiveGatewayRegistrationFromSettingsAsync()
        }
    }

    private func refreshActiveGatewayRegistrationFromSettingsAsync() async {
        guard let appModel else { return }
        guard let cfg = appModel.activeGatewayConnectConfig else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }

        let nodeOptions = await self.makeConnectOptions(stableID: cfg.stableID)
        let refreshedConfig = GatewayConnectConfig(
            url: cfg.url,
            stableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            nodeOptions: nodeOptions)
        appModel.applyGatewayConnectConfig(refreshedConfig)
    }

    func clearPendingTrustPrompt() {
        self.pendingTrustPrompt = nil
        self.pendingTrustConnect = nil
    }

    func acceptPendingTrustPrompt() async {
        guard let pending = self.pendingTrustConnect,
              let prompt = self.pendingTrustPrompt,
              pending.stableID == prompt.stableID
        else { return }

        GatewayTLSStore.saveFingerprint(prompt.fingerprintSha256, stableID: pending.stableID)
        self.clearPendingTrustPrompt()

        if pending.isManual {
            GatewaySettingsStore.saveLastGatewayConnectionManual(
                host: prompt.host,
                port: prompt.port,
                useTLS: true,
                stableID: pending.stableID)
        } else {
            GatewaySettingsStore.saveLastGatewayConnectionDiscovered(stableID: pending.stableID, useTLS: true)
        }

        let instanceId = GatewaySettingsStore.currentInstanceID()
        let token =
            pending.authOverride.map(\.token) ?? GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken =
            pending.authOverride.map(\.bootstrapToken) ?? GatewaySettingsStore.loadGatewayBootstrapToken(
                instanceId: instanceId)
        let password =
            pending.authOverride.map(\.password) ?? GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let tlsParams = GatewayTLSParams(
            required: true,
            expectedFingerprint: prompt.fingerprintSha256,
            allowTOFU: false,
            storeKey: pending.stableID)

        self.didAutoConnect = true
        self.startAutoConnect(
            url: pending.url,
            gatewayStableID: pending.stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
    }

    func declinePendingTrustPrompt() {
        self.clearPendingTrustPrompt()
        self.appModel?.gatewayStatusText = "Offline"
    }

    @discardableResult
    func trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem) async -> Bool {
        guard problem.canTrustRotatedCertificate,
              let stableID = problem.tlsStoreKey,
              let fingerprint = problem.tlsObservedFingerprint
        else {
            self.appModel?.gatewayStatusText = "Certificate review required"
            return false
        }

        guard GatewayTLSStore.replaceFingerprint(fingerprint, stableID: stableID) else {
            self.appModel?.gatewayStatusText = "Could not update gateway certificate"
            return false
        }

        GatewayDiagnostics.log(
            "gateway tls pin replaced stableID=\(stableID) "
                + "old=\(problem.tlsExpectedFingerprint ?? "unknown") new=\(fingerprint)")
        self.appModel?.gatewayStatusText = "Gateway certificate updated. Reconnecting…"
        if let appModel = self.appModel, let cfg = appModel.activeGatewayConnectConfig {
            let currentTLS = cfg.tls
            let refreshedTLS = GatewayTLSParams(
                required: currentTLS?.required ?? true,
                expectedFingerprint: fingerprint,
                allowTOFU: currentTLS?.allowTOFU ?? false,
                storeKey: currentTLS?.storeKey ?? stableID)
            let refreshedConfig = GatewayConnectConfig(
                url: cfg.url,
                stableID: cfg.stableID,
                tls: refreshedTLS,
                token: cfg.token,
                bootstrapToken: cfg.bootstrapToken,
                password: cfg.password,
                nodeOptions: cfg.nodeOptions)
            appModel.applyGatewayConnectConfig(refreshedConfig)
        } else {
            await self.connectLastKnown()
        }
        return true
    }

    private func updateFromDiscovery() {
        let newGateways = self.discovery.gateways
        self.gateways = newGateways
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredGateway(from: newGateways)
        self.maybeAutoConnect()
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
        guard !self.didAutoConnect else { return }
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayServerName == nil else { return }

        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "gateway.autoconnect") else { return }
        let manualEnabled = defaults.bool(forKey: "gateway.manual.enabled")

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)

        if manualEnabled {
            let manualHost = defaults.string(forKey: "gateway.manual.host")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !manualHost.isEmpty else { return }

            let manualPort = defaults.integer(forKey: "gateway.manual.port")
            let manualTLS = defaults.bool(forKey: "gateway.manual.tls")
            let resolvedUseTLS = self.resolveManualUseTLS(host: manualHost, useTLS: manualTLS)
            guard let resolvedPort = self.resolveManualPort(
                host: manualHost,
                port: manualPort,
                useTLS: resolvedUseTLS)
            else { return }

            let stableID = self.manualStableID(host: manualHost, port: resolvedPort)
            let tlsParams = self.resolveManualTLSParams(
                stableID: stableID,
                tlsEnabled: resolvedUseTLS)

            guard let url = self.buildGatewayURL(
                host: manualHost,
                port: resolvedPort,
                useTLS: tlsParams?.required == true)
            else { return }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: stableID,
                tls: tlsParams,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password)
            return
        }

        if let lastKnown = GatewaySettingsStore.loadLastGatewayConnection(),
           self.startLastKnownAutoConnect(
               lastKnown,
               token: token,
               bootstrapToken: bootstrapToken,
               password: password)
        {
            return
        }

        let preferredStableID = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastDiscoveredStableID = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let candidates = [preferredStableID, lastDiscoveredStableID].filter { !$0.isEmpty }
        if let targetStableID = candidates.first(where: { id in
            self.gateways.contains(where: { $0.stableID == id })
        }) {
            guard let target = self.gateways.first(where: { $0.stableID == targetStableID }) else { return }
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: target.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(target)
            }
            return
        }

        if self.gateways.count == 1, let gateway = self.gateways.first {
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(gateway)
            }
            return
        }

        _ = self.startSavedManualEndpointFallback()
    }

    private func startLastKnownAutoConnect(
        _ lastKnown: GatewaySettingsStore.LastGatewayConnection,
        token: String?,
        bootstrapToken: String?,
        password: String?) -> Bool
    {
        switch lastKnown {
        case let .manual(host, port, useTLS, stableID):
            let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
            let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
            let tlsParams = stored.map { fp in
                GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
            }
            guard let url = self.buildGatewayURL(
                host: host,
                port: port,
                useTLS: resolvedUseTLS && tlsParams != nil)
            else { return false }

            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard tlsParams != nil else { return false }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: stableID,
                tls: tlsParams,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password)
            return true
        case .discovered:
            return false
        }
    }

    private func attemptAutoReconnectIfNeeded() {
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        // Avoid starting duplicate connect loops while a prior config is active.
        guard appModel.activeGatewayConnectConfig == nil else { return }
        guard UserDefaults.standard.bool(forKey: "gateway.autoconnect") else { return }
        self.didAutoConnect = false
        self.maybeAutoConnect()
    }

    private func savedManualEndpointFallback(defaults: UserDefaults = .standard) -> SavedManualEndpoint? {
        guard defaults.bool(forKey: "gateway.autoconnect") else { return nil }
        guard defaults.bool(forKey: "gateway.manual.enabled") else { return nil }
        let host = defaults.string(forKey: "gateway.manual.host")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return nil }

        let configuredPort = defaults.integer(forKey: "gateway.manual.port")
        let configuredUseTLS = defaults.bool(forKey: "gateway.manual.tls")
        let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: configuredUseTLS)
        guard let resolvedPort = self.resolveManualPort(
            host: host,
            port: configuredPort,
            useTLS: resolvedUseTLS)
        else { return nil }

        return SavedManualEndpoint(host: host, port: resolvedPort, useTLS: resolvedUseTLS)
    }

    private func startSavedManualEndpointFallback() -> Bool {
        guard let endpoint = self.savedManualEndpointFallback() else { return false }
        self.didAutoConnect = true
        Task { [weak self] in
            await self?.connectManual(
                host: endpoint.host,
                port: endpoint.port,
                useTLS: endpoint.useTLS)
        }
        return true
    }

    private func connectSavedManualEndpointFallback() async -> Bool {
        guard let endpoint = self.savedManualEndpointFallback() else { return false }
        await self.connectManual(
            host: endpoint.host,
            port: endpoint.port,
            useTLS: endpoint.useTLS)
        return true
    }

    private func updateLastDiscoveredGateway(from gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        let defaults = UserDefaults.standard
        let preferred = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let existingLast = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred.isEmpty, existingLast.isEmpty else { return }
        guard let first = gateways.first else { return }

        defaults.set(first.stableID, forKey: "gateway.lastDiscoveredStableID")
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(first.stableID)
    }

    private func startAutoConnect(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        forceReconnect: Bool = false)
    {
        guard let appModel else { return }
        appModel.gatewayStatusText = "Connecting…"
        Task { [weak self, weak appModel] in
            guard let self, let appModel else { return }
            if forceReconnect {
                await appModel.resetGatewaySessionsForForcedReconnect()
            }
            let nodeOptions = await self.makeConnectOptions(stableID: gatewayStableID)
            let cfg = GatewayConnectConfig(
                url: url,
                stableID: gatewayStableID,
                tls: tls,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                nodeOptions: nodeOptions)
            appModel.applyGatewayConnectConfig(cfg, forceReconnect: forceReconnect)
        }
    }

    private func resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams?
    {
        let stableID = gateway.stableID
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        // Never let unauthenticated discovery (TXT) override a stored pin.
        if let stored {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        if gateway.tlsEnabled || gateway.tlsFingerprintSha256 != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveManualTLSParams(
        stableID: String,
        tlsEnabled: Bool) -> GatewayTLSParams?
    {
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if tlsEnabled || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func probeTLSFingerprint(url: URL) async -> String? {
        await withCheckedContinuation { continuation in
            let probe = GatewayTLSFingerprintProbe(url: url, timeoutSeconds: 3) { fp in
                continuation.resume(returning: fp)
            }
            probe.start()
        }
    }

    private func resolveServiceEndpoint(_ endpoint: NWEndpoint) async -> (host: String, port: Int)? {
        guard case let .service(name, type, domain, _) = endpoint else { return nil }
        let key = "\(domain)|\(type)|\(name)"
        return await withCheckedContinuation { continuation in
            let resolver = GatewayServiceResolver(name: name, type: type, domain: domain) { [weak self] result in
                Task { @MainActor in
                    self?.pendingServiceResolvers[key] = nil
                    continuation.resume(returning: result)
                }
            }
            self.pendingServiceResolvers[key] = resolver
            resolver.start()
        }
    }
}

extension GatewayConnectionController {
    private func buildGatewayURL(host: String, port: Int, useTLS: Bool) -> URL? {
        let scheme = useTLS ? "wss" : "ws"
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.url
    }

    private func resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        useTLS || self.shouldRequireTLS(host: host)
    }

    private func shouldRequireTLS(host: String) -> Bool {
        !LoopbackHost.isLocalNetworkHost(host)
    }

    private func shouldForceTLS(host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty { return false }
        return trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.")
    }

    private func manualStableID(host: String, port: Int) -> String {
        "manual|\(host.lowercased())|\(port)"
    }

    private func makeConnectOptions(stableID: String?) async -> GatewayConnectOptions {
        let defaults = UserDefaults.standard
        let displayName = self.resolvedDisplayName(defaults: defaults)
        let resolvedClientId = self.resolvedClientId(defaults: defaults, stableID: stableID)
        let permissions = await self.currentPermissions()

        return GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: self.currentCaps(),
            commands: self.currentCommands(),
            permissions: permissions,
            clientId: resolvedClientId,
            clientMode: "node",
            clientDisplayName: displayName)
    }

    private func resolvedClientId(defaults: UserDefaults, stableID: String?) -> String {
        if let stableID,
           let override = GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID)
        {
            return override
        }
        let manualClientId = defaults.string(forKey: "gateway.manual.clientId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if manualClientId?.isEmpty == false {
            return manualClientId!
        }
        return "openclaw-ios"
    }

    private func resolveManualPort(host: String, port: Int, useTLS: Bool) -> Int? {
        if port > 0 {
            return port <= 65535 ? port : nil
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return nil }
        if useTLS, self.shouldForceTLS(host: trimmedHost) {
            return 443
        }
        return 18789
    }

    private func resolvedDisplayName(defaults: UserDefaults) -> String {
        let key = "node.displayName"
        let existingRaw = defaults.string(forKey: key)
        let resolved = NodeDisplayName.resolve(
            existing: existingRaw,
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let existing = existingRaw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if existing.isEmpty || NodeDisplayName.isGeneric(existing) {
            defaults.set(resolved, forKey: key)
        }
        return resolved
    }

    private func currentCaps() -> [String] {
        var caps = [
            OpenClawCapability.canvas.rawValue,
            OpenClawCapability.screen.rawValue,
        ]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(OpenClawCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(OpenClawCapability.voiceWake.rawValue) }

        let locationModeRaw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        let locationMode = OpenClawLocationMode(rawValue: locationModeRaw) ?? .off
        if locationMode != .off { caps.append(OpenClawCapability.location.rawValue) }

        caps.append(OpenClawCapability.device.rawValue)
        caps.append(OpenClawCapability.talk.rawValue)
        if WatchMessagingService.isSupportedOnDevice() {
            caps.append(OpenClawCapability.watch.rawValue)
        }
        caps.append(OpenClawCapability.photos.rawValue)
        caps.append(OpenClawCapability.contacts.rawValue)
        caps.append(OpenClawCapability.calendar.rawValue)
        caps.append(OpenClawCapability.reminders.rawValue)
        if Self.motionAvailable() {
            caps.append(OpenClawCapability.motion.rawValue)
        }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            OpenClawCanvasA2UICommand.reset.rawValue,
            OpenClawScreenCommand.record.rawValue,
            OpenClawSystemCommand.notify.rawValue,
            OpenClawChatCommand.push.rawValue,
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
        }
        if caps.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if caps.contains(OpenClawCapability.device.rawValue) {
            commands.append(OpenClawDeviceCommand.status.rawValue)
            commands.append(OpenClawDeviceCommand.info.rawValue)
        }
        if caps.contains(OpenClawCapability.watch.rawValue) {
            commands.append(OpenClawWatchCommand.status.rawValue)
            commands.append(OpenClawWatchCommand.notify.rawValue)
        }
        if caps.contains(OpenClawCapability.photos.rawValue) {
            commands.append(OpenClawPhotosCommand.latest.rawValue)
        }
        if caps.contains(OpenClawCapability.contacts.rawValue) {
            commands.append(OpenClawContactsCommand.search.rawValue)
            commands.append(OpenClawContactsCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.calendar.rawValue) {
            commands.append(OpenClawCalendarCommand.events.rawValue)
            commands.append(OpenClawCalendarCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.reminders.rawValue) {
            commands.append(OpenClawRemindersCommand.list.rawValue)
            commands.append(OpenClawRemindersCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.motion.rawValue) {
            commands.append(OpenClawMotionCommand.activity.rawValue)
            commands.append(OpenClawMotionCommand.pedometer.rawValue)
        }

        return commands
    }

    private func currentPermissions() async -> [String: Bool] {
        var permissions: [String: Bool] = [:]
        permissions["camera"] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        permissions["microphone"] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        permissions["speechRecognition"] = SFSpeechRecognizer.authorizationStatus() == .authorized
        let locationStatus = CLLocationManager().authorizationStatus
        let locationServicesEnabled = await Self.locationServicesEnabled()
        permissions["location"] = Self.isLocationAvailable(
            servicesEnabled: locationServicesEnabled,
            status: locationStatus)
        permissions["screenRecording"] = RPScreenRecorder.shared().isAvailable

        let photoStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        permissions["photos"] = photoStatus == .authorized || photoStatus == .limited
        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        permissions["contacts"] = contactsStatus == .authorized || contactsStatus == .limited

        let calendarStatus = EKEventStore.authorizationStatus(for: .event)
        permissions["calendar"] = Self.hasEventKitAccess(calendarStatus)
        let remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        permissions["reminders"] = Self.hasEventKitAccess(remindersStatus)

        let motionStatus = CMMotionActivityManager.authorizationStatus()
        let pedometerStatus = CMPedometer.authorizationStatus()
        permissions["motion"] =
            motionStatus == .authorized || pedometerStatus == .authorized

        let watchStatus = WatchMessagingService.currentStatusSnapshot()
        permissions["watchSupported"] = watchStatus.supported
        permissions["watchPaired"] = watchStatus.paired
        permissions["watchAppInstalled"] = watchStatus.appInstalled
        permissions["watchReachable"] = watchStatus.reachable

        return permissions
    }

    private static func locationServicesEnabled() async -> Bool {
        await Task.detached(priority: .utility) {
            CLLocationManager.locationServicesEnabled()
        }.value
    }

    private static func isLocationAvailable(servicesEnabled: Bool, status: CLAuthorizationStatus) -> Bool {
        guard servicesEnabled else { return false }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            return true
        default:
            return false
        }
    }

    private static func hasEventKitAccess(_ status: EKAuthorizationStatus) -> Bool {
        status == .fullAccess || status == .writeOnly
    }

    private static func motionAvailable() -> Bool {
        CMMotionActivityManager.isActivityAvailable() || CMPedometer.isStepCountingAvailable()
    }
}

#if DEBUG
extension GatewayConnectionController {
    func _test_resolvedDisplayName(defaults: UserDefaults) -> String {
        self.resolvedDisplayName(defaults: defaults)
    }

    func _test_currentCaps() -> [String] {
        self.currentCaps()
    }

    func _test_currentCommands() -> [String] {
        self.currentCommands()
    }

    static func _test_isLocationAvailable(servicesEnabled: Bool, status: CLAuthorizationStatus) -> Bool {
        self.isLocationAvailable(servicesEnabled: servicesEnabled, status: status)
    }

    func _test_setGateways(_ gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        self.gateways = gateways
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }

    func _test_didAutoConnect() -> Bool {
        self.didAutoConnect
    }

    func _test_resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams?
    {
        self.resolveDiscoveredTLSParams(gateway: gateway)
    }

    func _test_resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        self.resolveManualUseTLS(host: host, useTLS: useTLS)
    }

    func _test_resolveManualPort(host: String, port: Int, useTLS: Bool) -> Int? {
        self.resolveManualPort(host: host, port: port, useTLS: useTLS)
    }

    func _test_savedManualEndpointFallback(
        defaults: UserDefaults = .standard) -> (host: String, port: Int, useTLS: Bool)?
    {
        self.savedManualEndpointFallback(defaults: defaults).map { endpoint in
            (host: endpoint.host, port: endpoint.port, useTLS: endpoint.useTLS)
        }
    }
}
#endif

private final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
    private struct ProbeState {
        var didFinish = false
        var session: URLSession?
        var task: URLSessionWebSocketTask?
    }

    private let url: URL
    private let timeoutSeconds: Double
    private let onComplete: (String?) -> Void
    private let state = OSAllocatedUnfairLock(initialState: ProbeState())

    init(url: URL, timeoutSeconds: Double, onComplete: @escaping (String?) -> Void) {
        self.url = url
        self.timeoutSeconds = timeoutSeconds
        self.onComplete = onComplete
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = self.timeoutSeconds
        config.timeoutIntervalForResource = self.timeoutSeconds
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: self.url)
        self.state.withLock { s in
            s.session = session
            s.task = task
        }
        task.resume()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.timeoutSeconds) { [weak self] in
            self?.finish(nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let fp = GatewayTLSFingerprintProbe.certificateFingerprint(trust)
        completionHandler(.cancelAuthenticationChallenge, nil)
        self.finish(fp)
    }

    private func finish(_ fingerprint: String?) {
        typealias FinishState = (Bool, URLSessionWebSocketTask?, URLSession?)
        let (shouldComplete, taskToCancel, sessionToInvalidate) = self.state.withLock { s -> FinishState in
            guard !s.didFinish else { return (false, nil, nil) }
            s.didFinish = true
            let task = s.task
            let session = s.session
            s.task = nil
            s.session = nil
            return (true, task, session)
        }
        guard shouldComplete else { return }
        taskToCancel?.cancel(with: .goingAway, reason: nil)
        sessionToInvalidate?.invalidateAndCancel()
        self.onComplete(fingerprint)
    }

    private static func certificateFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let cert = chain.first
        else {
            return nil
        }
        let data = SecCertificateCopyData(cert) as Data
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
