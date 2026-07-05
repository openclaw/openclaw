import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

struct TerminalHubScreenTests {
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

    @Test func `terminal URL flips scheme and carries only view parameter`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/ws")),
            token: "secret-token")

        let url = TerminalHubScreen.terminalURL(config: config)

        #expect(url?.absoluteString == "https://gateway.example.com:8443/?view=terminal")
        // Credentials must never ride in the page URL; they travel via the
        // document-start auth user script instead.
        #expect(url?.absoluteString.contains("secret-token") == false)
    }

    @Test func `terminal URL uses plain HTTP for insecure endpoints`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "ws://192.168.1.10:18789")))

        let url = TerminalHubScreen.terminalURL(config: config)

        #expect(url?.absoluteString == "http://192.168.1.10:18789/?view=terminal")
    }

    @Test func `auth user script carries credentials gated to the page origin`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: " secret-token ",
            password: "fallback-password")

        let script = TerminalHubScreen.terminalAuthUserScript(config: config)

        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        // JSONSerialization escapes forward slashes, hence the `\/` literals.
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:8443\"") == true)
        #expect(script?.contains("\"token\":\"secret-token\"") == true)
        #expect(script?.contains("\"password\":\"fallback-password\"") == true)
        #expect(script?.contains("\"gatewayUrl\":\"wss:\\/\\/gateway.example.com:8443\"") == true)
    }

    @Test func `auth user script falls back to stored operator token`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: nil,
            password: nil)

        let script = TerminalHubScreen.terminalAuthUserScript(
            config: config,
            storedOperatorToken: " stored-token ")

        #expect(script?.contains("\"token\":\"stored-token\"") == true)
    }

    @Test func `web content identity changes with stored operator token`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        #expect(
            TerminalHubScreen.webContentIdentity(config: config, storedOperatorToken: "token-a") !=
                TerminalHubScreen.webContentIdentity(config: config, storedOperatorToken: "token-b"))
    }

    @Test func `auth user script is omitted without credentials`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")), token: "   ")

        #expect(
            TerminalHubScreen.terminalAuthUserScript(config: config, storedOperatorToken: nil) == nil)
        #expect(
            TerminalHubScreen.terminalAuthUserScript(config: nil, storedOperatorToken: nil) == nil)
    }
}
