import Contacts
import CoreLocation
import CoreMotion
import EventKit
import Foundation
import OpenClawKit
import ReplayKit
import UIKit

struct GatewayManualTransportPresentation: Equatable {
    let requiresTLS: Bool
    let effectiveTLS: Bool
    let helperText: String?
}

extension GatewayConnectionController {
    /// Rebuild connect options from current local settings (caps/commands/permissions)
    /// and re-apply the active gateway config so capability changes take effect immediately.
    @discardableResult
    func refreshActiveGatewayRegistrationFromSettings() -> Task<Void, Never> {
        Task { [weak self] in
            await self?.refreshActiveGatewayRegistrationFromSettingsAsync()
        }
    }

    private func refreshActiveGatewayRegistrationFromSettingsAsync() async {
        guard let appModel else { return }
        // A queued handoff owns transport recovery; registration must not restart its paused sessions.
        while self.pendingAutoConnectTask != nil || appModel.hasGatewaySessionResetInFlight {
            await self.pendingAutoConnectTask?.value
            await appModel.waitForGatewaySessionResetIfNeeded()
        }
        // A failed switch keeps the previous route paused until its retry, trust, or cancel decision.
        guard let cfg = appModel.activeGatewayConnectConfig,
              appModel.gatewayAutoReconnectEnabled,
              appModel.unresolvedGatewayPreconnectStableID == nil
        else { return }
        let generation = appModel.gatewayConnectGeneration
        var refreshedConfig = cfg
        refreshedConfig.nodeOptions = await self.makeConnectOptions(
            deviceAuthGatewayID: cfg.nodeOptions.deviceAuthGatewayID,
            allowStoredDeviceAuth: cfg.nodeOptions.allowStoredDeviceAuth)
        await appModel.waitForGatewaySessionResetIfNeeded()
        // A replacement route can commit within the same connect generation while permissions are sampled.
        guard !Task.isCancelled,
              !self.hasPendingForgetCleanup(stableID: cfg.stableID),
              cfg.ingressAuthorization?.isCurrent() != false,
              appModel.gatewayAutoReconnectEnabled,
              appModel.unresolvedGatewayPreconnectStableID == nil,
              appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: cfg) == true
        else { return }
        // Unchanged registration is not a request to recover deliberately stopped transport loops.
        guard !cfg.hasSameConnectionInputs(as: refreshedConfig) else { return }
        appModel.applyGatewayConnectConfig(refreshedConfig, expectedGeneration: generation)
    }

    func observeGatewayRegistration() {
        withObservationTracking {
            _ = self.appModel?.locationAuthorizationSnapshot
            // Camera, microphone and speech grants from in-app prompts must reach registration too.
            _ = self.appModel?.mediaAuthorizationSnapshot
            // An attempt can invalidate a sampled refresh without replacing the route (for example, cancellation).
            _ = self.appModel?.gatewayConnectGeneration
            // Startup and target-review resume may install options captured before authorization changed.
            _ = self.appModel?.activeGatewayConnectConfig
            // Resolving a failed switch releases a refresh deferred while the previous route was paused.
            _ = self.appModel?.unresolvedGatewayPreconnectStableID
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.observeGatewayRegistration()
                await self.refreshActiveGatewayRegistrationFromSettingsAsync()
            }
        }
    }

    func buildGatewayURL(
        host: String,
        port: Int,
        useTLS: Bool,
        contextPath: String? = nil) -> URL?
    {
        GatewayConnectEndpoint(
            host: host,
            port: port,
            tls: useTLS,
            contextPath: contextPath).websocketURL
    }

    func resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        Self.manualTransportPresentation(
            host: host,
            requestedTLS: useTLS).effectiveTLS
    }

    static func manualTransportPresentation(
        host: String,
        requestedTLS: Bool) -> GatewayManualTransportPresentation
    {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let requiresTLS = !trimmedHost.isEmpty && !LoopbackHost.isLocalNetworkHost(trimmedHost)
        let effectiveTLS = requestedTLS || requiresTLS
        let helperText: String? = if requiresTLS {
            String(localized: "Secure connection is required for this host.")
        } else if effectiveTLS {
            nil
        } else {
            String(localized: "Use only on a trusted private network.")
        }
        return GatewayManualTransportPresentation(
            requiresTLS: requiresTLS,
            effectiveTLS: effectiveTLS,
            helperText: helperText)
    }

    /// Explains a Host value the connect path cannot turn into a gateway URL. It asks the same
    /// endpoint builder as `connectManual`, so the forms block exactly the input that would fail.
    static func manualHostValidationMessage(host: String) -> String? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty,
              GatewayConnectEndpoint(host: trimmedHost, port: 1, tls: true).websocketURL == nil
        else { return nil }
        if trimmedHost.contains("://") {
            return String(localized: "Enter the host without https:// or wss://.")
        }
        return String(localized: "Enter only a host name or IP address.")
    }

    func manualStableID(host: String, port: Int, contextPath: String? = nil) -> String {
        ManualAuthOverride.manualStableID(host: host, port: port, contextPath: contextPath)
    }

    func makeConnectOptions(
        deviceAuthGatewayID: String?,
        allowStoredDeviceAuth: Bool = true) async -> GatewayConnectOptions
    {
        let defaults = UserDefaults.standard
        let displayName = self.resolvedDisplayName(defaults: defaults)
        let permissions = await self.currentPermissions()
        let caps = self.currentCaps()

        return GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: caps,
            commands: Self.commands(for: caps),
            permissions: permissions,
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: displayName,
            allowStoredDeviceAuth: allowStoredDeviceAuth,
            deviceAuthGatewayID: GatewayStableIdentifier.exact(deviceAuthGatewayID))
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
        var caps = [OpenClawCapability.screen.rawValue]

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
        if HealthAuthorization.isEnabled {
            caps.append(OpenClawCapability.health.rawValue)
        }

        return caps
    }

    private static func commands(for caps: [String]) -> [String] {
        [
            OpenClawScreenCommand.record.rawValue,
            OpenClawSystemCommand.notify.rawValue,
            OpenClawChatCommand.push.rawValue,
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ] + caps.flatMap { capability -> [String] in
            switch capability {
            case OpenClawCapability.camera.rawValue:
                [
                    OpenClawCameraCommand.list.rawValue,
                    OpenClawCameraCommand.snap.rawValue,
                    OpenClawCameraCommand.clip.rawValue,
                ]
            case OpenClawCapability.location.rawValue:
                [OpenClawLocationCommand.get.rawValue]
            case OpenClawCapability.device.rawValue:
                [OpenClawDeviceCommand.status.rawValue, OpenClawDeviceCommand.info.rawValue]
            case OpenClawCapability.watch.rawValue:
                [OpenClawWatchCommand.status.rawValue, OpenClawWatchCommand.notify.rawValue]
            case OpenClawCapability.photos.rawValue:
                [OpenClawPhotosCommand.latest.rawValue]
            case OpenClawCapability.contacts.rawValue:
                [OpenClawContactsCommand.search.rawValue, OpenClawContactsCommand.add.rawValue]
            case OpenClawCapability.calendar.rawValue:
                [OpenClawCalendarCommand.events.rawValue, OpenClawCalendarCommand.add.rawValue]
            case OpenClawCapability.reminders.rawValue:
                [OpenClawRemindersCommand.list.rawValue, OpenClawRemindersCommand.add.rawValue]
            case OpenClawCapability.motion.rawValue:
                [OpenClawMotionCommand.activity.rawValue, OpenClawMotionCommand.pedometer.rawValue]
            case OpenClawCapability.health.rawValue:
                [OpenClawHealthCommand.summary.rawValue]
            default:
                []
            }
        }
    }

    private func currentPermissions() async -> [String: Bool] {
        var permissions: [String: Bool] = [:]
        let media = self.appModel?.mediaAuthorizationSnapshot ?? .current()
        permissions.merge(media.permissions) { _, sampled in sampled }
        let locationStatus = self.locationAuthorizationSnapshot.authorizationStatus
        let locationAvailable = await Self.isLocationAvailable(
            status: locationStatus,
            servicesEnabled: LocationService.servicesEnabled)
        // Authorization can change while the services probe is suspended; that change schedules a fresh sample.
        permissions["location"] = locationAvailable
            && self.locationAuthorizationSnapshot.authorizationStatus == locationStatus
        permissions["screenRecording"] = RPScreenRecorder.shared().isAvailable

        permissions["photos"] = PhotoLibraryAccess.canRead(PhotoLibraryAccess.authorizationStatus())
        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        permissions["contacts"] = contactsStatus == .authorized || contactsStatus == .limited

        let calendarStatus = EKEventStore.authorizationStatus(for: .event)
        permissions["calendar"] = Self.hasEventKitReadAccess(calendarStatus)
        let remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        permissions["reminders"] = Self.hasEventKitReadAccess(remindersStatus)

        let motionStatus = CMMotionActivityManager.authorizationStatus()
        let pedometerStatus = CMPedometer.authorizationStatus()
        permissions["motion"] =
            motionStatus == .authorized || pedometerStatus == .authorized

        return permissions
    }

    private static func isLocationAvailable(
        status: CLAuthorizationStatus,
        servicesEnabled: @MainActor () async -> Bool) async -> Bool
    {
        // An unauthorized app cannot use location regardless of the global switch;
        // registration need not wait for that system probe to report false.
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            await servicesEnabled()
        default:
            false
        }
    }

    private static func hasEventKitReadAccess(_ status: EKAuthorizationStatus) -> Bool {
        status == .fullAccess
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

    func _test_currentCommands() -> [String] {
        Self.commands(for: self.currentCaps())
    }

    func _test_currentPermissions() async -> [String: Bool] {
        await self.currentPermissions()
    }

    static func _test_hasEventKitReadAccess(_ status: EKAuthorizationStatus) -> Bool {
        self.hasEventKitReadAccess(status)
    }

    static func _test_isLocationAvailable(
        status: CLAuthorizationStatus,
        servicesEnabled: @MainActor () async -> Bool) async -> Bool
    {
        await self.isLocationAvailable(status: status, servicesEnabled: servicesEnabled)
    }

    func _test_resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        self.resolveManualUseTLS(host: host, useTLS: useTLS)
    }
}
#endif
