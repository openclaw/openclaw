import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct AuthenticatedControlUIAuthHandoffTests {
    private static func makeConfig(
        gatewayID: String,
        token: String? = nil,
        password: String? = nil,
        includeDeviceIdentity: Bool = true,
        allowStoredDeviceAuth: Bool = true) throws -> GatewayConnectConfig
    {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            stableID: gatewayID,
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
                clientDisplayName: "Phone",
                includeDeviceIdentity: includeDeviceIdentity,
                allowStoredDeviceAuth: allowStoredDeviceAuth,
                deviceAuthGatewayID: gatewayID))
    }

    /// A config whose device-grant key has no stored token, as when the route changed
    /// after the gateway moved behind a reverse proxy and the operator socket has not
    /// persisted a device token under the new stableID yet.
    private static func makeConfigWithoutGrant(
        token: String? = "shared-token",
        password: String? = nil) throws -> GatewayConnectConfig
    {
        try Self.makeConfig(
            gatewayID: "manual|handoff-nogrant-\(UUID().uuidString)|8443",
            token: token,
            password: password)
    }

    @Test func `native contract is announced when operator route is live without stored grant`() throws {
        let config = try Self.makeConfigWithoutGrant()
        let pageURL = AuthenticatedControlUI.pageURL(config: config, path: "", queryItems: [])
        #expect(AuthenticatedControlUI.storedOperatorToken(config: config) == nil)

        // Before the fix this payload had no `nativeConnectAuth` and the page minted a
        // throwaway browser identity on every load (#161800).
        let script = AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: pageURL,
            storedOperatorToken: nil,
            isNativeOperatorRouteLive: true)
        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
        // Shared credentials stay injected for older page bundles that predate the
        // native contract.
        #expect(script?.contains("\"token\":\"shared-token\"") == true)

        // Unconnected with no grant: the script stays silent so the page login gate works.
        let offline = AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: pageURL,
            storedOperatorToken: nil,
            isNativeOperatorRouteLive: false)
        #expect(offline?.contains("\"nativeConnectAuth\":true") == false)
        #expect(offline?.contains("\"token\":\"shared-token\"") == true)
    }

    @Test func `handler installs for live route without grant and still fails closed at signing`() throws {
        let config = try Self.makeConfigWithoutGrant()
        let pageURL = try #require(AuthenticatedControlUI.pageURL(config: config, path: "", queryItems: []))
        let appModel = NodeAppModel()
        // The handler co-installs with the widened announcement so a page told to use
        // native signing never falls back to browser identity at challenge time.
        let handler = AuthenticatedControlUI.nativeAuthHandler(
            config: config,
            storedOperatorToken: nil,
            appModel: appModel,
            isNativeOperatorRouteLive: true)
        #expect(handler != nil)

        // Without a stored grant the signature service refuses the challenge; the
        #expect(ControlUINativeGatewayAuthHandler.signedResult(
            request: try #require(ControlUINativeGatewayAuthHandler.Request(
                ["id": "req-1", "nonce": "nonce-1", "signedAt": 1_700_000_000_000])),
            config: config,
            expectedToken: "",
            binding: GatewayAuthBinding(source: .deviceToken, credentialFingerprint: nil, deviceId: "unrelated"),
            scopes: nil) == nil)

        // Route live but grant missing must not install when device identity is excluded.
        let excludedConfig = try Self.makeConfig(
            gatewayID: "manual|handoff-excluded-\(UUID().uuidString)|8443",
            includeDeviceIdentity: false)
        #expect(AuthenticatedControlUI.nativeAuthHandler(
            config: excludedConfig,
            storedOperatorToken: nil,
            appModel: appModel,
            isNativeOperatorRouteLive: true) == nil)
        let excludedScript = AuthenticatedControlUI.authUserScript(
            config: excludedConfig,
            pageURL: AuthenticatedControlUI.pageURL(config: excludedConfig, path: "", queryItems: []),
            storedOperatorToken: nil,
            isNativeOperatorRouteLive: true)
        #expect(excludedScript?.contains("\"nativeConnectAuth\":true") == false)
    }

    @Test func `ingress routes never announce the native contract`() throws {
        // Ingress-authorized configs must keep the main-branch behavior: no native
        // announcement, token-only payload, no handler.
        var config = try Self.makeConfig(
            gatewayID: "manual|handoff-ingress-\(UUID().uuidString)|8443",
            token: "shared-token")
        config.ingressAuthorization = GatewayIngressAuthorization(
            origin: try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.com"))),
            revision: 1,
            registrationID: UUID(),
            headers: { _ in [:] },
            isCurrent: { true },
            checkResponse: { _ in },
            load: { request, send in try await send(request) })

        let script = AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: AuthenticatedControlUI.pageURL(config: config, path: "", queryItems: []),
            storedOperatorToken: nil,
            isNativeOperatorRouteLive: true)
        #expect(script?.contains("\"nativeConnectAuth\":true") == false)
        #expect(script?.contains("\"token\":\"shared-token\"") == true)

        let appModel = NodeAppModel()
        #expect(AuthenticatedControlUI.nativeAuthHandler(
            config: config,
            storedOperatorToken: nil,
            appModel: appModel,
            isNativeOperatorRouteLive: true) == nil)
    }

    @Test func `stored grant appearance changes web content identity`() throws {
        // Locks the existing rebuild behavior: when a grant lands (or rotates), the
        // WebView is recreated so the new payload is injected fresh.
        let gatewayID = "manual|handoff-identity-\(UUID().uuidString)|8443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer { DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID) }

        let withoutGrant = try Self.makeConfig(gatewayID: gatewayID, token: "shared-token")
        let identityBefore = AuthenticatedControlUI.webContentIdentity(config: withoutGrant, storedOperatorToken: nil)

        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "granted-token",
            scopes: ["operator.read"],
            gatewayID: gatewayID)
        let storedToken = AuthenticatedControlUI.storedOperatorToken(config: withoutGrant)
        #expect(storedToken == "granted-token")
        let identityAfter = AuthenticatedControlUI.webContentIdentity(
            config: withoutGrant,
            storedOperatorToken: storedToken)
        #expect(identityBefore != identityAfter)

        // With the grant present, the legacy behavior is unchanged: the announcement
        // is driven by the stored grant even when the route is not flagged live.
        let script = AuthenticatedControlUI.authUserScript(
            config: withoutGrant,
            pageURL: AuthenticatedControlUI.pageURL(config: withoutGrant, path: "", queryItems: []),
            storedOperatorToken: storedToken,
            isNativeOperatorRouteLive: false)
        #expect(script?.contains("\"nativeConnectAuth\":true") == true)
    }
}
