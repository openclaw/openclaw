import AVFoundation
import CoreLocation
import Foundation
import KeyboardShortcuts
import OpenClawKit
import Speech
import UserNotifications
import WebKit

extension DashboardWindowController {
    func publishDeviceSettings() async {
        let sourceID = self.notificationSourceID
        guard let snapshot = await self.readDeviceSettingsSnapshot(sourceID: sourceID),
              self.canUseDeviceSettings(sourceID: sourceID), let script = try? snapshot.javaScript()
        else { return }
        _ = try? await self.webView.evaluateJavaScript(script)
    }

    func readDeviceSettingsSnapshot(sourceID: String) async -> DeviceSettingsSnapshot? {
        guard self.canUseDeviceSettings(sourceID: sourceID) else { return nil }
        let entries = await Self.devicePermissionEntries()
        // Permission reads can outlive a document; never deliver device data into its replacement.
        guard self.canUseDeviceSettings(sourceID: sourceID) else { return nil }
        let nodeId = MacNodeModeCoordinator.shared.connectedDeviceId()
        guard self.canUseDeviceSettings(sourceID: sourceID) else { return nil }
        return self.deviceSettingsSnapshot(permissions: entries, nodeId: nodeId)
    }

    func canUseDeviceSettings(sourceID: String) -> Bool {
        !Task.isCancelled && self.notificationSourceID == sourceID && self.isWindowOpen &&
            !self.isShowingFailurePage && self.documentHost.hasCurrentBrowserSession &&
            ControlUIDocumentHost.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }

    private func deviceSettingsSnapshot(
        permissions: [DeviceSettingsSnapshot.Permissions.Entry], nodeId: String?) -> DeviceSettingsSnapshot
    {
        let state = AppStateStore.shared
        let defaults = AppDefaults.standard
        let iconStyle = defaults.string(forKey: appIconStyleKey)
            .flatMap(AppIconStyle.init(rawValue:)) ?? .paper
        let locationMode = defaults.string(forKey: locationModeKey)
            .flatMap(OpenClawLocationMode.init(rawValue:)) ?? .off
        let updaterAvailable = self.updater?.isAvailable == true
        return DeviceSettingsSnapshot(
            device: .init(
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                profileName: AppProfile.current.name,
                nodeId: nodeId),
            app: .init(
                showDockIcon: state.showDockIcon,
                nativeExperienceEnabled: state.nativeExperienceEnabled,
                iconStyle: .init(
                    selectedId: iconStyle.rawValue,
                    available: AppIconStyle.allCases.filter { AppIconArtwork.isAvailable($0) }
                        .map { .init(id: $0.rawValue, name: $0.title) }),
                iconAnimationsEnabled: state.iconAnimationsEnabled,
                launchAtLogin: state.launchAtLogin,
                // A moved app can still remove its existing login item; enabling keeps its separate gate.
                launchAtLoginAvailable: self.deviceLaunchAtLoginAvailable ||
                    (!AppProfile.current.isActive && state.launchAtLogin),
                keepGatewayRunning: GatewayProcessManager.shared.gatewayHosting == .service,
                keepGatewayRunningAvailable: GatewayProcessManager.shared.keepGatewayRunningAvailable,
                quickChatEnabled: state.quickChatEnabled,
                quickChatShortcut: .some(KeyboardShortcuts.getShortcut(for: .toggleQuickChat)?.description),
                debugPaneEnabled: state.debugPaneEnabled),
            capabilities: .init(
                canvasEnabled: state.canvasEnabled,
                cameraEnabled: defaults.bool(forKey: cameraEnabledKey),
                desktopSharingEnabled: defaults.object(forKey: desktopSharingEnabledKey) as? Bool ??
                    MacNodeModeCoordinator.shared.desktopSharingEnabled,
                computerControlEnabled: isComputerControlEnabled(),
                computerControlProvider: ComputerControlProvider.current().rawValue,
                cuaDriverBundled: CuaDriverArtifact.bundledExecutableURL != nil,
                peekabooBridgeEnabled: state.peekabooBridgeEnabled,
                activeComputerPresenceEnabled: state.activeComputerPresenceEnabled,
                unattendedDesktopEnabled: MacDesktopAvailabilityCoordinator.shared.unattendedEnabled),
            desktopAvailability: .init(state: MacDesktopAvailabilityCoordinator.shared.refresh()),
            browser: .init(
                importAvailable: state.connectionMode == .local && BrowserProfileImportModel.shared.importAvailable,
                cookieSync: Self.deviceCookieSyncSnapshot(state: state),
                chromeSetupActions: ChromeExtensionSetupAction.allCases),
            permissions: .init(
                entries: permissions,
                location: .init(
                    mode: DeviceSettingsLocationMode(locationMode),
                    precise: defaults.object(forKey: locationPreciseKey) as? Bool ?? true)),
            voice: .init(
                supported: voiceWakeSupported && SpeechRecognitionRequestPolicy.supportsPassiveVoiceWake(
                    localeID: state.voiceWakeLocaleID),
                wakeEnabled: state.swabbleEnabled,
                wakeTriggersTalkMode: state.voiceWakeTriggersTalkMode,
                pushToTalkEnabled: state.voicePushToTalkEnabled,
                talkPhaseSoundsEnabled: state.talkPhaseSoundsEnabled,
                talkShiftToStopEnabled: state.talkShiftToStopEnabled,
                realtimeRelayEnabled: state.talkRealtimeRelayEnabled,
                triggerChime: state.voiceWakeTriggerChime != .none,
                sendChime: state.voiceWakeSendChime != .none,
                microphone: .init(
                    selectedId: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
                    devices: VoiceWakeDeviceOptions.microphones()),
                locale: VoiceWakeDeviceOptions.localeSettings(
                    primary: state.voiceWakeLocaleID,
                    additional: state.voiceWakeAdditionalLocaleIDs)),
            updates: .init(
                available: updaterAvailable,
                automatic: self.updater?.automaticallyChecksForUpdates ?? false,
                unavailableReason: updaterAvailable ? nil : AppProfile.current.isActive
                    ? String(localized: "App updates are unavailable while a profile is active.")
                    : String(localized: "Updates unavailable in this build.")))
    }

    var deviceLaunchAtLoginAvailable: Bool {
        !AppProfile.current.isActive && Bundle.main.bundleURL.pathExtension == "app" &&
            AppStateStore.shared.bundleLocationAllowsPersistentIntegration
    }

    private static func deviceCookieSyncSnapshot(state: AppState) -> DeviceSettingsSnapshot.CookieSync {
        let manager = CookieSyncManager.shared
        let syncState: DeviceSettingsSnapshot.CookieSync.State
        let detail: String?
        switch manager.state {
        case .stopped:
            syncState = state.cookieSyncEnabled ? .idle : .off
            detail = manager.lastSummary.map { String(format: String(localized: "Last sync: %@"), $0) }
                ?? String(localized: "Cookie sync is not active.")
        case .running:
            syncState = .running
            detail = manager.lastSummary ?? String(localized: "Watching this Mac's browser cookie store for changes.")
        case let .error(message):
            syncState = .error
            detail = message
        }
        return .init(
            available: manager.isAvailable,
            enabled: state.cookieSyncEnabled,
            domains: state.cookieSyncDomains,
            targetProfile: state.cookieSyncIntoProfile,
            state: syncState,
            detail: detail)
    }

    private static func devicePermissionEntries() async -> [DeviceSettingsSnapshot.Permissions.Entry] {
        var entries: [DeviceSettingsSnapshot.Permissions.Entry] = []
        for permission in DeviceSettingsPermission.macOSPermissions {
            guard let capability = permission.capability else { continue }
            let state = await PermissionManager.missingState(capability)
            let status: DeviceSettingsPermissionStatus = switch state {
            case nil: .granted
            case .denied: .denied
            default: .notDetermined
            }
            entries.append(.init(id: permission, status: status, state: state))
        }
        return entries
    }
}
