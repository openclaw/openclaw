import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct GatewayAccessDeviceAuthBindingTests {
    private final class MemoryStore {
        var values: [String: String] = [:]
        var deviceAuth: GatewayAccessDeviceAuthBindingStore.StoredDeviceAuth?

        var persistence: GatewayAccessDeviceAuthBindingStore.Persistence {
            .init(
                load: { self.values[$0] },
                save: {
                    self.values[$0] = $1
                    return true
                })
        }
    }

    private func bindingStore(
        memory: MemoryStore,
        role expectedRole: String = "operator") -> GatewayAccessDeviceAuthBindingStore
    {
        .init(persistence: memory.persistence, loadDeviceAuth: { role, gatewayID, profile in
            guard role == expectedRole,
                  gatewayID == self.gatewayID,
                  profile == .primary
            else { return nil }
            return memory.deviceAuth
        })
    }

    private let gatewayID = "gateway-stable-id"
    private let deviceID = "test-iphone"

    private func principal(
        tokens: CloudflareAccessTestTokens,
        subject: String,
        application: CloudflareAccessApplication,
        gatewayRoles: [String]? = nil) throws -> CloudflareAccessPrincipal
    {
        let session = try tokens.session(
            subject: subject,
            application: application,
            gatewayRoles: gatewayRoles)
        return try CloudflareAccessPrincipal.verified(from: session)
    }

    private func storedToken(_ token: String, role: String = "operator") -> GatewayAccessDeviceAuthBindingStore
    .StoredDeviceAuth {
        GatewayAccessDeviceAuthBindingStore.StoredDeviceAuth(
            deviceID: self.deviceID,
            entry: DeviceAuthEntry(
                token: token,
                role: role,
                scopes: role == "operator" ? ["operator.admin"] : [],
                updatedAtMs: 100,
                gatewayID: self.gatewayID))
    }

    @Test func `legacy operator admin token requires explicit Gateway role confirmation`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let owner = try principal(
            tokens: tokens,
            subject: "owner-A",
            application: application,
            gatewayRoles: ["admin"])
        let nonowner = try principal(
            tokens: tokens,
            subject: "nonowner-B",
            application: application)
        let memory = MemoryStore()
        let legacy = self.storedToken("legacy-admin-token")
        memory.deviceAuth = legacy
        let store = self.bindingStore(memory: memory)

        #expect(!store.allowsStoredDeviceAuth(
            entry: legacy,
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!store.allowsStoredDeviceAuth(
            entry: legacy,
            principal: nonowner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(store.authorizedScopes(
            entry: legacy,
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary).isEmpty)
        let legacyVersion = store.currentTokenVersion(
            role: "operator",
            gatewayID: self.gatewayID,
            profile: .primary)
        #expect(legacyVersion != nil)
        #expect(!store.bindCurrentTokenAfterHandshake(
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            previousVersion: legacyVersion))
        #expect(!store.bindGatewayIssuedToken(
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            persistedRoles: ["node"]))
        #expect(!store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(store.bindGatewayIssuedToken(
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            persistedRoles: ["operator"]))
        #expect(store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: owner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: nonowner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(memory.values.count == 1)
        #expect(memory.values.values.allSatisfy { !$0.contains("legacy-admin-token") })
    }

    @Test func `same verified principal renewal may reuse only the bound unrotated token`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let first = try tokens.session(
            subject: "owner-A",
            expires: Date().addingTimeInterval(1800),
            application: application)
        let renewal = try tokens.session(
            subject: "owner-A",
            expires: Date().addingTimeInterval(7200),
            application: application,
            gatewayRoles: ["admin"])
        let principal = try CloudflareAccessPrincipal.verified(from: first)
        let renewedPrincipal = try CloudflareAccessPrincipal.verified(from: renewal)
        let other = try self.principal(
            tokens: tokens,
            subject: "nonowner-B",
            application: application,
            gatewayRoles: ["admin"])
        let memory = MemoryStore()
        let store = GatewayAccessDeviceAuthBindingStore(persistence: memory.persistence)
        #expect(store.bind(
            "gateway-admin-A",
            principal: principal,
            deviceID: self.deviceID,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary))

        #expect(renewedPrincipal == principal)
        #expect(store.allowsStoredDeviceAuth(
            entry: self.storedToken("gateway-admin-A"),
            principal: renewedPrincipal,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!store.allowsStoredDeviceAuth(
            entry: self.storedToken("rotated-gateway-token"),
            principal: renewedPrincipal,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!store.allowsStoredDeviceAuth(
            entry: self.storedToken("gateway-admin-A"),
            principal: other,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
    }

    @Test func `identity switch blocks A until gateway reauthorizes the current token for B`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let ownerA = try principal(
            tokens: tokens,
            subject: "owner-A",
            application: application)
        let nonownerB = try principal(
            tokens: tokens,
            subject: "nonowner-B",
            application: application,
            gatewayRoles: ["admin"])
        let memory = MemoryStore()
        memory.deviceAuth = self.storedToken("gateway-admin-A")
        let store = self.bindingStore(memory: memory)
        let tokenVersionA = store.currentTokenVersion(
            role: "operator",
            gatewayID: self.gatewayID,
            profile: .primary)
        #expect(store.bindGatewayIssuedToken(
            principal: ownerA,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            persistedRoles: ["operator"]))
        #expect(!store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: nonownerB,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: ownerA,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))

        memory.deviceAuth = self.storedToken("gateway-admin-B")
        #expect(store.bindCurrentTokenAfterHandshake(
            principal: nonownerB,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            previousVersion: tokenVersionA))
        #expect(store.allowsStoredDeviceAuth(
            entry: self.storedToken("gateway-admin-B"),
            principal: nonownerB,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!store.allowsStoredDeviceAuth(
            entry: self.storedToken("gateway-admin-B"),
            principal: ownerA,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
    }

    @Test func `node reconnect never presents A token to B and binds only after Gateway rotation`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let ownerA = try principal(tokens: tokens, subject: "owner-A", application: application)
        let memberB = try principal(tokens: tokens, subject: "member-B", application: application)
        let memory = MemoryStore()
        memory.deviceAuth = self.storedToken("gateway-node-A", role: "node")
        let store = self.bindingStore(memory: memory, role: "node")
        #expect(store.bindGatewayIssuedToken(
            principal: ownerA,
            gatewayID: self.gatewayID,
            role: "node",
            profile: .primary,
            persistedRoles: ["node"]))

        let a = NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: ownerA,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store)
        let b = NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: memberB,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store)
        #expect(a.allowStoredDeviceAuth)
        #expect(!b.allowStoredDeviceAuth)

        var options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "ios",
            clientMode: "node",
            clientDisplayName: "Phone",
            allowStoredDeviceAuth: b.allowStoredDeviceAuth)
        options = NodeAppModel._test_nodeOptionsAfterSuccessfulDeviceAuthHandshake(
            options,
            principal: memberB,
            gatewayID: self.gatewayID,
            profile: .primary,
            previousTokenVersion: b.tokenVersion,
            bindingStore: store)
        #expect(!options.allowStoredDeviceAuth)
        #expect(!NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: memberB,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store).allowStoredDeviceAuth)

        memory.deviceAuth = self.storedToken("gateway-node-B", role: "node")
        options = NodeAppModel._test_nodeOptionsAfterSuccessfulDeviceAuthHandshake(
            options,
            principal: memberB,
            gatewayID: self.gatewayID,
            profile: .primary,
            previousTokenVersion: b.tokenVersion,
            bindingStore: store)
        #expect(options.allowStoredDeviceAuth)
        #expect(NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: memberB,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store).allowStoredDeviceAuth)
        #expect(!NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: ownerA,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store).allowStoredDeviceAuth)
        #expect(NodeAppModel._test_nodeDeviceAuthState(
            gatewayID: self.gatewayID,
            principal: nil,
            profile: .primary,
            fallbackAllowed: true,
            bindingStore: store).allowStoredDeviceAuth)
    }

    @Test func `access webview removes stale scoped device auth for an unbound principal`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let principal = try self.principal(
            tokens: tokens,
            subject: "nonowner-B",
            application: application)
        let ingress = GatewayIngressAuthorization(
            origin: application.origin,
            principal: principal,
            revision: 1,
            headers: { _ in [:] },
            isCurrent: { true },
            dashboardCookie: { _ in nil },
            checkResponse: { _ in },
            load: { request, operation in try await operation(request) })
        var config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.test")),
            stableID: self.gatewayID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone",
                allowStoredDeviceAuth: false))
        config.ingressAuthorization = ingress
        let script = try AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: #require(URL(string: "https://gateway.example.test/ui")),
            storedOperatorToken: "legacy-admin-token")

        #expect(script?.contains("const deviceAuthSeed = null;") == true)
        #expect(script?.contains("legacy-admin-token") == false)
        #expect(script?.contains("localStorage.removeItem(`openclaw.device.auth.v1:${scope}`);") == true)
        #expect(script?.contains("localStorage.removeItem(\"openclaw-device-identity-v1\")") == false)
    }

    @Test func `principal identity includes access origin issuer audience and subject`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let otherOrigin = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: "https://other.example.test:8443"))),
            issuer: application.issuer,
            audience: application.audience)
        let otherIssuer = try CloudflareAccessApplication(
            origin: application.origin,
            issuer: #require(URL(string: "https://other.cloudflareaccess.com")),
            audience: application.audience)
        let otherAudience = try CloudflareAccessApplication(
            origin: application.origin,
            issuer: application.issuer,
            audience: "different-audience")
        let baseline = try principal(
            tokens: tokens,
            subject: "same-subject",
            application: application)
        #expect(try self.principal(
            tokens: tokens,
            subject: "same-subject",
            application: otherOrigin) != baseline)
        #expect(try self.principal(
            tokens: tokens,
            subject: "same-subject",
            application: otherIssuer) != baseline)
        #expect(try self.principal(
            tokens: tokens,
            subject: "same-subject",
            application: otherAudience) != baseline)
        #expect(try self.principal(
            tokens: tokens,
            subject: "different-subject",
            application: application) != baseline)
    }
}
