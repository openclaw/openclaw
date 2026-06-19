import Testing
@testable import OpenClaw

@Suite struct SettingsNetworkingHelpersTests {
    @Test func diagnosticsIssuesNameEachReviewerVisibleCheck() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: false,
                discoveredGatewayCount: 0,
                talkConfigLoaded: false,
                notificationStatusText: "Not Set") == [
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
                notificationStatusText: "Allowed") == [.talkConfigMissing])
        #expect(
            SettingsDiagnostics.issueCount(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: true,
                notificationStatusText: "Allowed") == 0)
    }
}
