import OpenClawKit
import Testing

@Suite struct GatewayErrorsTests {
    @Test func bootstrapTokenInvalidIsNonRecoverable() {
        let error = GatewayConnectAuthError(
            message: "setup code expired",
            detailCode: GatewayConnectAuthDetailCode.authBootstrapTokenInvalid.rawValue,
            canRetryWithDeviceToken: false)

        #expect(error.isNonRecoverable)
        #expect(error.detail == .authBootstrapTokenInvalid)
    }
}
