import Foundation
import OpenClawKit

enum GatewayOnboardingReset {
    @MainActor
    static func prepareForBootstrapPairing(
        appModel: NodeAppModel,
        instanceId: String,
        gatewayStableID: String,
        disconnectGateway: Bool = true,
        defaults: UserDefaults = .standard)
    {
        self.prepare(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: gatewayStableID,
            disconnectGateway: disconnectGateway,
            defaults: defaults)
    }

    @MainActor
    static func reset(
        appModel: NodeAppModel,
        instanceId: String,
        defaults: UserDefaults = .standard)
    {
        self.prepare(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: nil,
            disconnectGateway: true,
            defaults: defaults)
        OnboardingStateStore.reset(defaults: defaults)

        defaults.set(false, forKey: "gateway.onboardingComplete")
        defaults.set(false, forKey: "gateway.hasConnectedOnce")
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.set("", forKey: "gateway.manual.host")
        defaults.set("", forKey: "gateway.setupCode")
        defaults.set(defaults.integer(forKey: "onboarding.requestID") + 1, forKey: "onboarding.requestID")
    }

    @MainActor
    private static func prepare(
        appModel: NodeAppModel,
        instanceId: String,
        gatewayStableID: String?,
        disconnectGateway: Bool,
        defaults: UserDefaults)
    {
        if disconnectGateway {
            appModel.disconnectGateway()
        }

        let trimmedInstanceId = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty {
            GatewaySettingsStore.deleteGatewayCredentials(instanceId: trimmedInstanceId)
        }

        let deviceId = DeviceIdentityStore.loadOrCreate().deviceId
        if let gatewayStableID {
            let authenticationOwnerID = GatewaySettingsStore.authenticationOwnerID(
                routeStableID: gatewayStableID)
            let shareDeviceId = DeviceIdentityStore.loadOrCreate(profile: .shareExtension).deviceId
            // Bootstrap replacement invalidates only the target. Other paired gateways remain
            // usable when the user switches back after reviewing or completing this setup.
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "node", gatewayID: authenticationOwnerID)
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "operator", gatewayID: authenticationOwnerID)
            DeviceAuthStore.clearToken(
                deviceId: shareDeviceId,
                role: "node",
                gatewayID: authenticationOwnerID,
                profile: .shareExtension)
            DeviceAuthStore.clearToken(
                deviceId: shareDeviceId,
                role: "operator",
                gatewayID: authenticationOwnerID,
                profile: .shareExtension)
            GatewayTLSStore.clearFingerprint(stableID: gatewayStableID)
        } else {
            // Full onboarding reset is the only path that intentionally forgets every gateway.
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "node")
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "operator")
            DeviceAuthStore.clearAll(profile: .shareExtension)
            GatewayTLSStore.clearAllFingerprints()
        }

        GatewaySettingsStore.clearLastGatewayConnection(defaults: defaults)
        GatewaySettingsStore.clearPreferredGatewayStableID(defaults: defaults)
        GatewaySettingsStore.clearLastDiscoveredGatewayStableID(defaults: defaults)
        defaults.set(false, forKey: "gateway.autoconnect")
    }
}
