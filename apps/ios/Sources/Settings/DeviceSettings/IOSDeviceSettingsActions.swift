import Foundation
import OpenClawKit
import UIKit
import UserNotifications

@MainActor
enum IOSDeviceSettingsActions {
    /// Native controls and the WebKit adapter share effects and consent; callers supply live authority.
    static func set(
        _ key: DeviceSettingKey,
        value: DeviceSettingValue,
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        confirm: @MainActor (IOSDeviceSettingsConsent) async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool) async throws -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        let required = IOSDeviceSettingsConsent.required(for: key, value: value, locationMode: self.locationMode)
        if let required {
            guard await confirm(required) else { return false }
        }
        guard !Task.isCancelled, isCurrent(),
              IOSDeviceSettingsConsent.required(for: key, value: value, locationMode: self.locationMode) == required
        else { return false }
        switch (key, value) {
        case let (.appearance, .string(raw)):
            if let preference = AppAppearancePreference(rawValue: raw) { appearanceModel.select(preference) }
        case let (.notificationsEnabled, .boolean(enabled)):
            _ = await self.setNotificationsEnabled(
                enabled, confirmDisclosure: { await confirm(.notificationEnrollment) }, isCurrent: isCurrent)
        case let (.cameraEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "camera.enabled")
            return true
        case let (.keepAwakeEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "screen.preventSleep")
        case let (.healthSummaryEnabled, .boolean(enabled)):
            if enabled {
                try await HealthAuthorization.enable(isCurrent: isCurrent)
            } else {
                HealthAuthorization.disable()
            }
            return true
        case let (.wakeEnabled, .boolean(enabled)): appModel.setVoiceWakeEnabled(enabled)
        case let (.talkEnabled, .boolean(enabled)): appModel.setTalkEnabled(enabled)
        case let (.talkButtonEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "talk.button.enabled")
        case let (.talkBackgroundEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "talk.background.enabled")
        case let (.speakerphoneEnabled, .boolean(enabled)): appModel.setTalkSpeakerphoneEnabled(enabled)
        case let (.locationMode, .string(raw)):
            guard let mode = DeviceSettingsLocationMode(rawValue: raw) else { return false }
            return await self.applyLocationMode(
                mode.nativeMode,
                appModel: appModel,
                isCurrent: isCurrent)
        default:
            // Precision is system-owned on iOS; unsupported platform settings only republish current state.
            break
        }
        return false
    }

    static func requestPermission(
        _ permission: DeviceSettingsPermission,
        appModel: NodeAppModel,
        permissions: IOSDeviceSettingsPermissions,
        confirm: @MainActor (IOSDeviceSettingsConsent) async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool) async throws -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        switch permission {
        case .notifications:
            _ = await IOSDeviceSettingsActions.requestNotificationPermission(
                confirmDisclosure: { await confirm(.notificationEnrollment) },
                isCurrent: isCurrent)
            return false
        case .location:
            let mode = self.locationMode == .off ? .whileUsing : self.locationMode
            _ = await appModel.requestLocationPermissions(mode: mode, isCurrent: isCurrent)
            return true
        default:
            try await permissions.request(permission, isCurrent: isCurrent)
            return [.camera, .microphone, .speechRecognition, .contacts, .calendars, .reminders, .photos]
                .contains(permission)
        }
    }

    private static var locationMode: OpenClawLocationMode {
        UserDefaults.standard.string(forKey: "location.enabledMode")
            .flatMap(OpenClawLocationMode.init(rawValue:)) ?? .off
    }

    static func applyLocationMode(
        _ mode: OpenClawLocationMode,
        appModel: NodeAppModel,
        isCurrent: @MainActor () -> Bool = { true }) async -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        let granted = await appModel.requestLocationPermissions(mode: mode, isCurrent: isCurrent)
        guard granted, !Task.isCancelled, isCurrent() else { return false }
        UserDefaults.standard.set(mode.rawValue, forKey: "location.enabledMode")
        return true
    }

    static func setNotificationsEnabled(
        _ enabled: Bool,
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async -> UNAuthorizationStatus?
    {
        guard !Task.isCancelled, isCurrent() else { return nil }
        if !enabled {
            UserDefaults.standard.set(false, forKey: NotificationServingPreference.storageKey)
            UIApplication.shared.unregisterForRemoteNotifications()
            return nil
        }
        guard await self.prepareNotificationEnrollment(
            confirmDisclosure: confirmDisclosure,
            isCurrent: isCurrent)
        else { return nil }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard !Task.isCancelled, isCurrent() else { return nil }
        if status == .notDetermined {
            return await self.authorizeNotifications(isCurrent: isCurrent)
        }
        UserDefaults.standard.set(true, forKey: NotificationServingPreference.storageKey)
        self.registerForRemoteNotificationsIfEnrollmentReady(status: status)
        if !SettingsNotificationStatus(status).allowsNotifications,
           let url = URL(string: UIApplication.openNotificationSettingsURLString)
        {
            await UIApplication.shared.open(url)
        }
        return status
    }

    static func requestNotificationPermission(
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async -> UNAuthorizationStatus?
    {
        guard await self.prepareNotificationEnrollment(
            confirmDisclosure: confirmDisclosure,
            isCurrent: isCurrent)
        else { return nil }
        return await self.authorizeNotifications(isCurrent: isCurrent)
    }

    static func registerForRemoteNotificationsIfEnrollmentReady(status: UNAuthorizationStatus) {
        guard NotificationServingPreference.isEnabled(),
              !PushBuildConfig.current.usesOpenClawHostedRelay || PushEnrollmentConsent.disclosureAccepted,
              SettingsNotificationStatus(status).allowsNotifications
        else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private static func prepareNotificationEnrollment(
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @MainActor () -> Bool) async -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        if PushBuildConfig.current.usesOpenClawHostedRelay, !PushEnrollmentConsent.disclosureAccepted {
            guard await confirmDisclosure(), !Task.isCancelled, isCurrent() else { return false }
            PushEnrollmentConsent.markDisclosureAccepted()
        }
        return true
    }

    private static func authorizeNotifications(
        isCurrent: @escaping @MainActor @Sendable () -> Bool) async -> UNAuthorizationStatus?
    {
        guard !Task.isCancelled, isCurrent() else { return nil }
        let center = UNUserNotificationCenter.current()
        let granted = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
            center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in completion(granted) }
        }
        guard !Task.isCancelled, isCurrent() else { return nil }
        let status = await center.notificationSettings().authorizationStatus
        guard !Task.isCancelled, isCurrent() else { return nil }
        UserDefaults.standard.set(
            granted && SettingsNotificationStatus(status).allowsNotifications,
            forKey: NotificationServingPreference.storageKey)
        self.registerForRemoteNotificationsIfEnrollmentReady(status: status)
        return status
    }
}
