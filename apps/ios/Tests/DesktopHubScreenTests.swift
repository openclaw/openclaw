import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct DesktopHubScreenTests {
    private static func makeConfig(
        url: URL,
        token: String? = nil,
        password: String? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|gateway.example.com|443",
            tls: nil,
            token: token,
            bootstrapToken: nil,
            password: password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))
    }

    @Test func `standalone desktop URL uses document mode without credentials`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/openclaw/")),
            token: "secret-token",
            password: "secret-password")

        let url = ControlUIHubPage.desktop(source: nil, session: nil).url(config: config)

        #expect(url?.absoluteString == "https://gateway.example.com:8443/openclaw/focus/desktop")
        #expect(url?.absoluteString.contains("secret-token") == false)
        #expect(url?.absoluteString.contains("secret-password") == false)
    }

    @Test func `session desktop URL includes the session key`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "ws://192.168.1.10:18789")),
            token: "secret-token")

        let url = ControlUIHubPage.desktop(source: nil, session: "agent:main/mobile session").url(config: config)

        #expect(
            url?.absoluteString ==
                "http://192.168.1.10:18789/focus/desktop/session/agent%3Amain%2Fmobile%20session")
        #expect(url?.absoluteString.contains("secret-token") == false)
    }

    @Test func `explicit desktop source wins over the session`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        let url = ControlUIHubPage.desktop(
            source: "node:worker-1/primary?mode=qa",
            session: "agent:main:mobile").url(config: config)

        #expect(
            url?.absoluteString ==
                "https://gateway.example.com/focus/desktop/source/node%3Aworker-1%2Fprimary%3Fmode%3Dqa")
    }

    @Test func `empty desktop source and session are normalized away`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        let url = ControlUIHubPage.desktop(source: "  ", session: "  ").url(config: config)

        #expect(url?.absoluteString == "https://gateway.example.com/focus/desktop")
    }

    @Test func `desktop reload identity follows the resolved destination`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))
        let first = ControlUIHubPage.desktop(source: nil, session: "first")
        let second = ControlUIHubPage.desktop(source: nil, session: "second")
        let source = ControlUIHubPage.desktop(source: "worker", session: "first")
        let sameSource = ControlUIHubPage.desktop(source: " worker ", session: "second")

        #expect(first.webContentIdentity(config: config, storedOperatorToken: nil) !=
            second.webContentIdentity(config: config, storedOperatorToken: nil))
        #expect(first.webContentIdentity(config: config, storedOperatorToken: nil) !=
            source.webContentIdentity(config: config, storedOperatorToken: nil))
        #expect(source.webContentIdentity(config: config, storedOperatorToken: nil) ==
            sameSource.webContentIdentity(config: config, storedOperatorToken: nil))
    }

    @Test func `desktop auth script carries credentials outside the URL`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com")),
            token: " secret-token ",
            password: "secret-password")

        let page = ControlUIHubPage.desktop(source: "gateway", session: nil)
        let url = page.url(config: config)
        let script = page.authUserScript(
            config: config,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))

        #expect(url?.absoluteString == "https://gateway.example.com/focus/desktop/source/gateway")
        #expect(url?.absoluteString.contains("secret-token") == false)
        #expect(url?.absoluteString.contains("secret-password") == false)
        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        #expect(script?.contains("\"token\":\"secret-token\"") == true)
        #expect(script?.contains("\"password\":\"secret-password\"") == true)
    }
}
