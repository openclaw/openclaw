import OpenClawKit
import Testing
@testable import OpenClaw

struct GeneralSettingsRemoteAuthTests {
    @Test func `settings remote test maps auth issue to structured status`() {
        let issue = RemoteGatewayAuthIssue.tokenRequired
        #expect(GeneralSettings.remoteStatus(for: .authIssue(issue)) == .authIssue(issue))
    }

    @Test func `settings remote test keeps generic failures separate from auth issues`() {
        #expect(GeneralSettings.remoteStatus(for: .failed("SSH failed")) == .failed("SSH failed"))
        #expect(GeneralSettings.remoteStatus(for: .authIssue(.pairingRequired)) != .failed("SSH failed"))
    }

    @Test func `shared auth prompt exposes recovery copy for token required`() {
        let issue = RemoteGatewayAuthIssue.tokenRequired
        let style = RemoteGatewayAuthPromptView.promptStyle(for: issue)

        #expect(style.systemImage == "key.fill")
        #expect(issue.body.contains("gateway.auth.token"))
        #expect(issue.footnote?.contains("openclaw doctor --generate-gateway-token") == true)
    }

    @Test func `shared auth prompt exposes pair approve guidance`() {
        let issue = RemoteGatewayAuthIssue.pairingRequired

        #expect(RemoteGatewayAuthPromptView.promptStyle(for: issue).systemImage == "link.badge.plus")
        #expect(issue.body.contains("`/pair approve`"))
    }
}
