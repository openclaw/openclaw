import Foundation

enum GatewayDiscoveryPreferences {
    private static let preferredStableIDKey = "gateway.preferredStableID"
    private static let preferredRouteBindingKey = "gateway.preferredStableIDRouteBinding.v1"

    static func preferredStableID() -> String? {
        AppDefaults.standard.string(forKey: self.preferredStableIDKey)?.nonEmpty
    }

    static func setPreferredStableID(_ stableID: String?) {
        // A caller without an endpoint binding cannot prove that a prior binding
        // belongs to this id. The bound overload installs a fresh one below.
        AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
        if let trimmed = stableID?.nonEmpty {
            AppDefaults.standard.set(trimmed, forKey: self.preferredStableIDKey)
        } else {
            AppDefaults.standard.removeObject(forKey: self.preferredStableIDKey)
        }
    }

    static func preferredRouteBinding() -> String? {
        AppDefaults.standard.string(forKey: self.preferredRouteBindingKey)?.nonEmpty
    }

    static func setPreferredStableID(_ stableID: String?, routeBinding: String?) {
        self.setPreferredStableID(stableID)
        guard self.preferredStableID() != nil,
              let routeBinding = routeBinding?.nonEmpty
        else { return }
        AppDefaults.standard.set(routeBinding, forKey: self.preferredRouteBindingKey)
    }

    /// Discovery ids name one concrete Gateway. Persist the non-secret fallback
    /// route beside the id so an app-off config edit cannot reuse its receipts.
    static func routeBinding(
        connectionMode: AppState.ConnectionMode,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String,
        root: [String: Any] = OpenClawConfigFile.loadDict()) -> String?
    {
        guard connectionMode == .remote else { return nil }
        let sshRemotePort: Int = if remoteTransport == .ssh {
            RemotePortTunnel.ports(
                root: root,
                sshHost: CommandResolver.parseSSHTarget(remoteTarget)?.host ?? "").remote
        } else {
            18789
        }
        return OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: remoteTransport,
            remoteURL: remoteURL,
            remoteTarget: remoteTarget,
            sshRemotePort: sshRemotePort)
    }

    /// Stable, non-secret owner for credentials issued by one selected route.
    /// This intentionally ignores discovery ids: manual direct/SSH selections
    /// must still isolate device tokens before discovery has identified them.
    static func deviceAuthGatewayID(
        root: [String: Any],
        connectionMode: AppState.ConnectionMode? = nil) -> String?
    {
        let mode = connectionMode ?? ConnectionModeResolver.resolve(root: root).mode
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        return self.deviceAuthGatewayID(
            connectionMode: mode,
            remoteTransport: resolution.transport,
            remoteURL: resolution.directURL?.absoluteString ?? GatewayRemoteConfig.resolveUrlString(root: root) ?? "",
            remoteTarget: resolution.transport == .ssh ? CommandResolver.connectionSettings(configRoot: root)
                .target : "",
            root: root)
    }

    static func deviceAuthGatewayID(
        connectionMode: AppState.ConnectionMode,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String,
        root: [String: Any] = OpenClawConfigFile.loadDict()) -> String?
    {
        if connectionMode == .remote {
            return self.routeBinding(
                connectionMode: connectionMode,
                remoteTransport: remoteTransport,
                remoteURL: remoteURL,
                remoteTarget: remoteTarget,
                root: root)
        }
        return OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: connectionMode,
            preferredGatewayID: nil,
            remoteTransport: remoteTransport,
            remoteURL: remoteURL,
            remoteTarget: remoteTarget)
    }

    @discardableResult
    static func clearPreferredStableIDIfRouteBindingMismatch(_ currentRouteBinding: String?) -> Bool {
        guard self.preferredStableID() != nil else {
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return false
        }
        guard let stored = self.preferredRouteBinding(),
              let current = currentRouteBinding?.nonEmpty,
              stored == current
        else {
            self.setPreferredStableID(nil, routeBinding: nil)
            return true
        }
        return false
    }
}
