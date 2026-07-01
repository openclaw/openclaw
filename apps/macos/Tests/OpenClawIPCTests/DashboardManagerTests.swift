import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct DashboardManagerTests {
    @Test func `dashboard presentation uses resolved auth token consistently`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: "stale-config-token",
            password: "  shared-password  ")

        let presentation = try DashboardManager.makeDashboardPresentation(
            config: config,
            mode: .local,
            authToken: "resolved-native-token",
            localBasePath: "/control")

        #expect(
            presentation.url.absoluteString ==
                "http://127.0.0.1:18789/control/#token=resolved-native-token")
        #expect(presentation.auth.gatewayUrl == "ws://127.0.0.1:18789/control/")
        #expect(presentation.auth.token == "resolved-native-token")
        #expect(presentation.auth.password == "shared-password")
    }
}
