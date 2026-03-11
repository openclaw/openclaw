import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingRemoteAuthPromptTests {
    @Test func `auth detail codes map to remote auth issues`() {
        let tokenMissing = GatewayConnectAuthError(
            message: "token missing",
            detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue,
            canRetryWithDeviceToken: false)
        let tokenMismatch = GatewayConnectAuthError(
            message: "token mismatch",
            detailCode: GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
            canRetryWithDeviceToken: false)
        let tokenNotConfigured = GatewayConnectAuthError(
            message: "token not configured",
            detailCode: GatewayConnectAuthDetailCode.authTokenNotConfigured.rawValue,
            canRetryWithDeviceToken: false)
        let passwordMissing = GatewayConnectAuthError(
            message: "password missing",
            detailCode: GatewayConnectAuthDetailCode.authPasswordMissing.rawValue,
            canRetryWithDeviceToken: false)
        let unknown = GatewayConnectAuthError(
            message: "other",
            detailCode: "SOMETHING_ELSE",
            canRetryWithDeviceToken: false)

        #expect(RemoteGatewayAuthIssue(error: tokenMissing) == .tokenRequired)
        #expect(RemoteGatewayAuthIssue(error: tokenMismatch) == .tokenMismatch)
        #expect(RemoteGatewayAuthIssue(error: tokenNotConfigured) == .gatewayTokenNotConfigured)
        #expect(RemoteGatewayAuthIssue(error: passwordMissing) == .passwordRequired)
        #expect(RemoteGatewayAuthIssue(error: unknown) == nil)
    }

    @Test func `password detail family maps to password required issue`() {
        let mismatch = GatewayConnectAuthError(
            message: "password mismatch",
            detailCode: GatewayConnectAuthDetailCode.authPasswordMismatch.rawValue,
            canRetryWithDeviceToken: false)
        let notConfigured = GatewayConnectAuthError(
            message: "password not configured",
            detailCode: GatewayConnectAuthDetailCode.authPasswordNotConfigured.rawValue,
            canRetryWithDeviceToken: false)

        #expect(RemoteGatewayAuthIssue(error: mismatch) == .passwordRequired)
        #expect(RemoteGatewayAuthIssue(error: notConfigured) == .passwordRequired)
    }

    @Test func `token field visibility follows onboarding rules`() {
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: nil) == false)
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: true,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "secret",
            remoteTokenUnsupported: false,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: true,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .tokenRequired))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .tokenMismatch))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .gatewayTokenNotConfigured) == false)
    }

    @Test func `paired device success copy explains auth source`() {
        let pairedDevice = RemoteGatewayProbeSuccess(authSource: .deviceToken)
        let sharedToken = RemoteGatewayProbeSuccess(authSource: .sharedToken)
        let noAuth = RemoteGatewayProbeSuccess(authSource: GatewayAuthSource.none)

        #expect(pairedDevice.title == "Connected via paired device")
        #expect(pairedDevice.detail == "This Mac used a stored device token. New or unpaired devices may still need the gateway token.")
        #expect(sharedToken.title == "Connected with gateway token")
        #expect(sharedToken.detail == nil)
        #expect(noAuth.title == "Remote gateway ready")
        #expect(noAuth.detail == nil)
    }
}
