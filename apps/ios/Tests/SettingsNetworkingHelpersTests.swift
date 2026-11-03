import Testing
@testable import OpenClaw

struct SettingsNetworkingHelpersTests {
    @Test func `permission does not hide rejected push registration`() {
        #expect(SettingsDiagnostics.issues(
            gatewayConnected: true, discoveredGatewayCount: 1, talkConfigLoaded: true,
            notificationsAllowed: true, pushRegistrationDegraded: true) == [.notificationRegistrationUnavailable])
    }

    @Test func `diagnostics issues name each reviewer visible check`() {
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

    @Test func `diagnostics issues require talk config only after gateway connects`() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: false,
                notificationsAllowed: true) == [.talkConfigMissing])
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: true,
                notificationsAllowed: true).isEmpty)
    }
}
