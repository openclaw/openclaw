import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
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
        #expect(!IOSDashboardNativeGatewayAuthProvider.accessBindingAllowsDeviceToken(
            legacy.entry.token,
            principal: owner,
            gatewayID: self.gatewayID,
            profile: .primary,
            store: store))
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
        let legacyVersion = store.tokenVersion(for: memory.deviceAuth)
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
        #expect(IOSDashboardNativeGatewayAuthProvider.accessBindingAllowsDeviceToken(
            legacy.entry.token,
            principal: owner,
            gatewayID: self.gatewayID,
            profile: .primary,
            store: store))
        #expect(!store.allowsStoredDeviceAuth(
            entry: memory.deviceAuth,
            principal: nonowner,
            gatewayID: self.gatewayID,
            role: "operator",
            profile: .primary,
            fallbackAllowed: true))
        #expect(!IOSDashboardNativeGatewayAuthProvider.accessBindingAllowsDeviceToken(
            legacy.entry.token,
            principal: nonowner,
            gatewayID: self.gatewayID,
            profile: .primary,
            store: store))
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
        let tokenVersionA = store.tokenVersion(for: memory.deviceAuth)
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

    @Test func `node reconnect withholds another principal's token and binds actual Gateway rotation`() async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "node-binding-\(UUID().uuidString)")
        defer { state.restore() }
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        defer { server.stop() }
        server.acceptedOperatorScopes = []
        let gatewayID = "node-binding-\(UUID().uuidString)"
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let ownerA = try principal(tokens: tokens, subject: "owner-A", application: application)
        let memberB = try principal(tokens: tokens, subject: "member-B", application: application)
        let store = GatewayAccessDeviceAuthBindingStore.shared
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        model.setScenePhase(.active)
        func allows(_ principal: CloudflareAccessPrincipal) -> Bool {
            store.allowsStoredDeviceAuth(
                entry: store.storedDeviceAuth(role: "node", gatewayID: gatewayID, profile: .primary),
                principal: principal,
                gatewayID: gatewayID,
                role: "node",
                profile: .primary,
                fallbackAllowed: true)
        }
        func reconnect(
            as principal: CloudflareAccessPrincipal?,
            issuing token: String?) async throws -> NativeGatewayWebSocketFixture.ConnectAuth
        {
            // Reset the channel too: its internal reconnect can reuse a newly persisted token
            // without exercising NodeAppModel's next-attempt binding decision.
            await model.resetGatewaySessionsForForcedReconnect()
            let previousNodeCount = server.roles.filter { $0 == "node" }.count
            server.issuedDeviceTokensByRole = token.map { ["node": $0] } ?? [:]
            let authorization = principal.map { principal in
                GatewayIngressAuthorization(
                    origin: application.origin,
                    principal: principal,
                    revision: 1,
                    registrationID: UUID(),
                    headers: { _ in [:] },
                    isCurrent: { true },
                    dashboardCookie: { _ in nil },
                    checkResponse: { _ in },
                    load: { request, operation in try await operation(request) })
            }
            model.applyGatewayConnectConfig(GatewayConnectConfig(
                url: server.url(),
                stableID: gatewayID,
                tls: GatewayTLSParams(required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-ios",
                    clientMode: "node",
                    clientDisplayName: "Binding Test",
                    deviceAuthGatewayID: gatewayID),
                ingressAuthorization: authorization))
            try await TestWait.observed("native node connected") { model.gatewayConnected }
            try await TestWait.state("node connect frame") {
                server.roles.filter { $0 == "node" }.count > previousNodeCount
            }
            let nodeIndex = try #require(server.roles.indices.filter { server.roles[$0] == "node" }
                .dropFirst(previousNodeCount).first)
            return try #require(server.capturedAuth(at: nodeIndex))
        }
        let empty = NativeGatewayWebSocketFixture.ConnectAuth(token: nil, bootstrapToken: nil, deviceToken: nil)
        do {
            #expect(try await reconnect(as: ownerA, issuing: "gateway-node-A") == empty)
            // Connected state precedes post-handshake binding; observe it before resetting.
            try await TestWait.state("issued A token bound") { allows(ownerA) }
            #expect(try await reconnect(as: memberB, issuing: nil) == empty)
            #expect(store.storedDeviceAuth(role: "node", gatewayID: gatewayID, profile: .primary)?.entry.token ==
                "gateway-node-A")
            #expect(!allows(memberB))
            #expect(try await reconnect(as: memberB, issuing: "gateway-node-B") == empty)
            try await TestWait.state("issued B token bound") { allows(memberB) }
            #expect(!allows(ownerA))
            #expect(try await reconnect(as: memberB, issuing: nil) == .init(
                token: "gateway-node-B", bootstrapToken: nil, deviceToken: nil))
            #expect(try await reconnect(as: ownerA, issuing: nil) == empty)
            #expect(try await reconnect(as: nil, issuing: nil) == .init(
                token: "gateway-node-B", bootstrapToken: nil, deviceToken: nil))
        } catch {
            model.disconnectGateway()
            await model.waitForGatewaySessionResetIfNeeded()
            throw error
        }
        model.disconnectGateway()
        await model.waitForGatewaySessionResetIfNeeded()
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
