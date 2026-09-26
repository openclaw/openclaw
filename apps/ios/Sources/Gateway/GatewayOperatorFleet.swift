import Foundation
import OpenClawKit
import SwiftUI

/// Keeps operator sessions for non-focused gateways live in the foreground.
/// The focused gateway remains owned by `NodeAppModel`, including its capability-bearing
/// node session. This fleet therefore cannot route camera, screen, or device commands.
@MainActor
final class GatewayOperatorFleet {
    nonisolated static func backgroundStableIDs(
        connectedStableIDs: [String],
        focusedStableID: String?) -> [String]
    {
        var seen = Set<GatewayStableIdentifier.Key>()
        return connectedStableIDs.filter { stableID in
            guard !GatewayStableIdentifier.matches(stableID, focusedStableID),
                  let key = GatewayStableIdentifier.key(stableID)
            else { return false }
            return seen.insert(key).inserted
        }
    }

    private final class Runtime {
        let id = UUID()
        let session = GatewayNodeSession()
        let config: GatewayConnectConfig
        var task: Task<Void, Never>?
        var isPausedForAttention = false

        init(config: GatewayConnectConfig) {
            self.config = config
        }
    }

    private var runtimes: [GatewayStableIdentifier.Key: Runtime] = [:]

    func reconcile(
        desiredStableIDs: [String],
        configs: [GatewayConnectConfig])
    {
        let desiredKeys = Set(desiredStableIDs.compactMap(GatewayStableIdentifier.key))
        var desired: [GatewayStableIdentifier.Key: GatewayConnectConfig] = [:]
        for config in configs {
            guard let key = GatewayStableIdentifier.key(config.effectiveStableID),
                  desiredKeys.contains(key)
            else { continue }
            desired[key] = config
        }

        // Endpoint resolution is transient for discovered gateways. Keep a healthy runtime on
        // its last proven route until the user disables, forgets, or focuses that gateway.
        for key in self.runtimes.keys where !desiredKeys.contains(key) {
            self.stopRuntime(key: key)
        }
        for (key, config) in desired {
            if let runtime = self.runtimes[key],
               runtime.config.hasSameConnectionInputs(as: config),
               runtime.task != nil || runtime.isPausedForAttention
            {
                continue
            }
            self.stopRuntime(key: key)
            self.startRuntime(config: config, key: key)
        }
    }

    func stop(stableID: String) {
        guard let key = GatewayStableIdentifier.key(stableID) else { return }
        self.stopRuntime(key: key)
    }

    func stopAll() {
        for key in Array(self.runtimes.keys) {
            self.stopRuntime(key: key)
        }
    }

    func retire(origin: CloudflareAccessOrigin) async {
        let matching = self.runtimes.filter { $0.value.config.ingressAuthorization?.origin == origin }
        for (key, runtime) in matching {
            self.runtimes.removeValue(forKey: key)
            runtime.task?.cancel()
        }
        // Remove every old runtime before awaiting: reconciliation cannot adopt a
        // partially retired account, and disconnect lets pending connects unwind.
        for runtime in matching.values {
            await runtime.session.disconnect()
            await runtime.task?.value
        }
    }

    private func startRuntime(
        config: GatewayConnectConfig,
        key: GatewayStableIdentifier.Key)
    {
        let runtime = Runtime(config: config)
        self.runtimes[key] = runtime
        runtime.task = Task { @MainActor [weak self, weak runtime] in
            guard let self, let runtime else { return }
            await self.run(runtime: runtime, key: key)
        }
    }

    private func stopRuntime(key: GatewayStableIdentifier.Key) {
        guard let runtime = self.runtimes.removeValue(forKey: key) else { return }
        runtime.task?.cancel()
        runtime.task = nil
        Task {
            await runtime.session.disconnect()
        }
    }

    private func run(runtime: Runtime, key: GatewayStableIdentifier.Key) async {
        let config = runtime.config
        // The session box is part of GatewayNodeSession's route identity. Keep it for
        // this runtime so a retry cannot replace an unchanged TLS transport.
        let sessionBox = config.webSocketSessionBox()
        let runtimeID = runtime.id
        var attempt = 0
        while !Task.isCancelled, self.runtimes[key]?.id == runtime.id {
            do {
                let bindingStore = GatewayAccessDeviceAuthBindingStore.shared
                let optionsBase = Self.operatorOptions(from: config.nodeOptions)
                let deviceAuthGatewayID = optionsBase.deviceAuthGatewayID ?? config.effectiveStableID
                let storedOperatorAuth = bindingStore.storedDeviceAuth(
                    role: "operator",
                    gatewayID: deviceAuthGatewayID,
                    profile: optionsBase.deviceIdentityProfile)
                var options = optionsBase
                options.allowStoredDeviceAuth = bindingStore.allowsStoredDeviceAuth(
                    entry: storedOperatorAuth,
                    principal: config.ingressAuthorization?.principal,
                    gatewayID: deviceAuthGatewayID,
                    role: "operator",
                    profile: optionsBase.deviceIdentityProfile,
                    fallbackAllowed: optionsBase.allowStoredDeviceAuth)
                let tokenVersionBeforeConnect = bindingStore.tokenVersion(for: storedOperatorAuth)
                try await runtime.session.connect(
                    url: config.url,
                    credentials: GatewayNodeSessionCredentials(
                        token: config.token,
                        bootstrapToken: config.bootstrapToken,
                        password: config.password),
                    connectOptions: options,
                    sessionBox: sessionBox,
                    extraHeadersProvider: {
                        if let ingress = config.ingressAuthorization {
                            return try await ingress.headers(config.url)
                        }
                        return GatewaySettingsStore.loadGatewayCustomHeaders(
                            gatewayStableID: config.effectiveStableID)
                    },
                    onConnected: { [weak self] in
                        await MainActor.run {
                            guard let self, self.runtimes[key]?.id == runtimeID else { return }
                            _ = GatewayAccessDeviceAuthBindingStore.shared.bindCurrentTokenAfterHandshake(
                                principal: config.ingressAuthorization?.principal,
                                gatewayID: deviceAuthGatewayID,
                                role: "operator",
                                profile: optionsBase.deviceIdentityProfile,
                                previousVersion: tokenVersionBeforeConnect)
                            _ = GatewaySettingsStore.markGatewayConnected(
                                stableID: config.effectiveStableID,
                                atMs: Int(Date().timeIntervalSince1970 * 1000))
                        }
                    },
                    onDisconnected: { _ in },
                    onInvoke: { request in
                        BridgeInvokeResponse(
                            id: request.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .invalidRequest,
                                message: "INVALID_REQUEST: background operator sessions cannot invoke node commands"))
                    })
                attempt = 0
                // connect returns at readiness; the channel owns the live connection.
                repeat {
                    try await Task.sleep(for: .seconds(1))
                } while await runtime.session.currentRoute() != nil
            } catch {
                guard !Task.isCancelled, self.runtimes[key]?.id == runtime.id else { break }
                // An in-place reconnect can retire an admission without canceling this runtime.
                if error is CancellationError { continue }
                attempt += 1
                let problem = GatewayConnectionProblemMapper.map(error: error)
                runtime.isPausedForAttention = problem?.pauseReconnect == true || problem?.needsPairingApproval == true
                if runtime.isPausedForAttention { break }
                let delay = min(pow(2.0, Double(min(attempt, 5))), 30.0)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        if self.runtimes[key]?.id == runtime.id {
            // A completed task cannot keep a runtime alive; auth pauses are retained separately.
            runtime.task = nil
        }
        await runtime.session.disconnect()
    }

    #if DEBUG
    func _test_runtimeStableIDs() -> [String] {
        self.runtimes.values.map(\.config.stableID)
    }
    #endif

    private static func operatorOptions(from nodeOptions: GatewayConnectOptions) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
            caps: [
                OpenClawGatewayClientCapability.inlineWidgets,
                OpenClawGatewayClientCapability.modelSelectionPolicy,
            ],
            commands: [],
            permissions: [:],
            clientId: nodeOptions.clientId,
            clientMode: "ui",
            clientDisplayName: nodeOptions.clientDisplayName,
            deviceIdentityProfile: nodeOptions.deviceIdentityProfile,
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: nodeOptions.allowStoredDeviceAuth,
            deviceAuthGatewayID: nodeOptions.deviceAuthGatewayID)
    }
}

extension GatewayConnectionController {
    @discardableResult
    func setGatewayConnectionEnabled(stableID: String, enabled: Bool) -> Bool {
        guard GatewaySettingsStore.setGatewayConnectionEnabled(stableID: stableID, enabled: enabled) else {
            return false
        }
        self.scheduleOperatorFleetReconcile()
        return true
    }

    func scheduleOperatorFleetReconcile(admissionCheckpoint: UInt64? = nil) {
        self.cancelOperatorFleetReconcile()
        guard currentScenePhase == .active else { return }
        let admissionCheckpoint = admissionCheckpoint ?? ingress.admissionCheckpoint()
        operatorFleetReconcileTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.reconcileOperatorFleet(admissionCheckpoint: admissionCheckpoint)
        }
    }

    func cancelOperatorFleetReconcile() {
        operatorFleetReconcileTask?.cancel()
        operatorFleetReconcileTask = nil
    }

    private func reconcileOperatorFleet(admissionCheckpoint: UInt64) async {
        let registry = GatewaySettingsStore.loadGatewayRegistry()
        let focusedID = registry.activeStableID
        let backgroundIDs = GatewayOperatorFleet.backgroundStableIDs(
            connectedStableIDs: registry.connectedStableIDs,
            focusedStableID: focusedID).filter { !self.hasPendingForgetCleanup(stableID: $0) }
        // Explicit focus/connection changes must take effect before unrelated discovery
        // resolution can suspend this reconciliation. Desired runtimes survive this prune.
        operatorFleet.reconcile(desiredStableIDs: backgroundIDs, configs: [])
        let connectedEntries = backgroundIDs.compactMap { connectedID in
            registry.entries.first {
                GatewayStableIdentifier.matches($0.stableID, connectedID)
            }
        }
        await withTaskGroup(of: GatewayConnectConfig?.self) { group in
            for entry in connectedEntries {
                group.addTask { [weak self] in
                    guard !Task.isCancelled,
                          let config = await self?.backgroundConnectConfig(
                              for: entry,
                              admissionCheckpoint: admissionCheckpoint)
                    else { return nil }
                    return config
                }
            }

            var configs: [GatewayConnectConfig] = []
            for await resolved in group {
                guard !Task.isCancelled, self.currentScenePhase == .active else {
                    group.cancelAll()
                    return
                }
                guard let resolved else { continue }
                configs.append(resolved)
                // Each route becomes usable independently; one stalled Bonjour resolver must
                // not hold manual or otherwise-resolved gateways behind it.
                self.operatorFleet.reconcile(desiredStableIDs: backgroundIDs, configs: configs)
            }
        }
    }

    private func backgroundConnectConfig(
        for entry: GatewaySettingsStore.GatewayRegistryEntry,
        admissionCheckpoint: UInt64) async -> GatewayConnectConfig?
    {
        let stableID = entry.stableID
        guard !Task.isCancelled, !hasPendingForgetCleanup(stableID: stableID) else { return nil }
        let route: (URL, GatewayTLSParams?)
        switch entry.kind {
        case .manual:
            guard let host = entry.host, let port = entry.port else { return nil }
            let useTLS = resolveManualUseTLS(host: host, useTLS: entry.useTLS)
            let tls = resolveManualTLSParams(stableID: stableID, tlsEnabled: useTLS)
            guard let url = buildGatewayURL(
                host: host,
                port: port,
                useTLS: tls?.required == true,
                contextPath: entry.contextPath)
            else { return nil }
            route = (url, tls)
        case .discovered:
            guard let gateway = gateways.first(where: {
                GatewayStableIdentifier.matches($0.stableID, stableID)
            }), let fingerprint = GatewayTLSStore.loadFingerprint(stableID: stableID)
            else { return nil }
            let target = if let serviceEndpointResolver {
                await serviceEndpointResolver(gateway.endpoint)
            } else {
                await resolveServiceEndpoint(gateway.endpoint)
            }
            guard let target,
                  let url = buildGatewayURL(host: target.host, port: target.port, useTLS: true)
            else { return nil }
            route = (
                url,
                GatewayTLSParams(
                    required: true,
                    expectedFingerprint: fingerprint,
                    allowTOFU: false,
                    storeKey: stableID))
        }

        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: GatewaySettingsStore.currentInstanceID(),
            gatewayStableID: stableID)
        let nodeOptions = await makeConnectOptions(
            stableID: stableID,
            deviceAuthGatewayID: GatewaySettingsStore.authenticationOwnerID(routeStableID: stableID),
            allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth)
        // Endpoint and permission work may outlive Forget's initial invalidation.
        // Its retained registry row is cleanup ownership, not fresh admission authority.
        guard !Task.isCancelled, !hasPendingForgetCleanup(stableID: stableID) else { return nil }
        let ingressAuthorization: GatewayIngressAuthorization?
        do {
            ingressAuthorization = try await ingress.prepare(
                route: .init(url: route.0, stableID: stableID, tls: route.1),
                userInitiated: false,
                admissionCheckpoint: admissionCheckpoint)
        } catch { return nil }
        guard !Task.isCancelled, !hasPendingForgetCleanup(stableID: stableID) else { return nil }
        return GatewayConnectConfig(
            url: route.0,
            stableID: stableID,
            tls: route.1,
            token: credentials.token,
            bootstrapToken: credentials.bootstrapToken,
            password: credentials.password,
            nodeOptions: nodeOptions,
            ingressAuthorization: ingressAuthorization)
    }
}
