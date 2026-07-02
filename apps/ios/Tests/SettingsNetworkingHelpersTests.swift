import Foundation
import Testing
@testable import OpenClaw

@Suite struct SettingsNetworkingHelpersTests {
    @Test func diagnosticsIssuesNameEachReviewerVisibleCheck() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: false,
                discoveredGatewayCount: 0,
                talkConfigLoaded: false,
                notificationsAllowed: false) == [
                    .gatewayOffline,
                    .discoveryUnavailable,
                    .notificationsUnavailable,
                ])
    }

    @Test func diagnosticsIssuesRequireTalkConfigOnlyAfterGatewayConnects() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: false,
                notificationsAllowed: true) == [.talkConfigMissing])
        #expect(
            SettingsDiagnostics.issueCount(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: true,
                notificationsAllowed: true) == 0)
    }

    @Test func notificationServingPreferenceDefaultsToEnabled() throws {
        let defaults = try Self.makeIsolatedDefaults()
        #expect(NotificationServingPreference.isEnabled(defaults: defaults))
    }

    @Test func notificationServingPreferenceCombinesAuthorizationAndAppPreference() throws {
        let defaults = try Self.makeIsolatedDefaults()
        #expect(NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.authorized,
            defaults: defaults))
        #expect(NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.provisional,
            defaults: defaults))
        #expect(NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.ephemeral,
            defaults: defaults))
        #expect(!NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.denied,
            defaults: defaults))
        #expect(!NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.notDetermined,
            defaults: defaults))

        NotificationServingPreference.setEnabled(false, defaults: defaults)

        #expect(!NotificationServingPreference.isServingEnabled(
            status: NotificationAuthorizationStatus.authorized,
            defaults: defaults))
    }

    @Test func settingsNotificationStatusBlocksCheckingAndUnknownToggleState() {
        #expect(!SettingsNotificationStatus.checking.allowsNotifications)
        #expect(!SettingsNotificationStatus.unknown.allowsNotifications)
    }

    private static func makeIsolatedDefaults() throws -> UserDefaults {
        let suiteName = "OpenClaw.NotificationServingPreferenceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
