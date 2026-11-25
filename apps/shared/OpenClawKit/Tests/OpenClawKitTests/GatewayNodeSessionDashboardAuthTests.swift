#if os(macOS) || os(iOS)
import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

struct GatewayNodeSessionDashboardAuthTests {
    @Test(.stateDirectoryIsolated, arguments: [nil, "native-dashboard-issued-token"] as [String?])
    @MainActor
    func `credential-free operator Dashboard uses live scopes and cannot reuse a retired route`(
        issuedToken: String?) async throws
    {
        let fixture = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [issuedToken, nil])
        defer { fixture.stop() }
        fixture.acceptedOperatorScopes = ["operator.read", "operator.admin"]
        let identity = DeviceIdentityStore.loadOrCreate()
        let gatewayID = "dashboard-native-\(UUID().uuidString)"
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            scopesAreExplicit: true,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "ui",
            clientDisplayName: "Dashboard Native Transport Test",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: gatewayID)
        let gateway = GatewayNodeSession()
        do {
            try await self.connect(gateway, fixture: fixture, options: options)
            let first = try #require(await gateway.currentRoute(ifGatewayID: gatewayID))
            #expect(fixture.capturedAuth(at: 0) == .init(token: nil, bootstrapToken: nil, deviceToken: nil))
            #expect(await gateway.httpResourceAuthorization(ifCurrentRoute: first)?.bearer == issuedToken)
            let authorization: Data
            do {
                authorization = try await gateway.controlUIDashboardAuthorization(
                    ifCurrentRoute: first, nonce: "dashboard-first", signedAtMs: 1_800_000_000_000)
            } catch {
                Issue.record("Dashboard signing failed for the current accepted credential-free operator route")
                throw error
            }
            try self.verify(
                authorization, identity: identity, scopes: ["operator.admin", "operator.read"],
                token: issuedToken, nonce: "dashboard-first")
            #expect(await gateway.controlUIDashboardLegacyCredentials(ifCurrentRoute: first) == nil)

            await gateway.disconnect()
            await #expect(throws: CancellationError.self) {
                _ = try await gateway.controlUIDashboardAuthorization(
                    ifCurrentRoute: first, nonce: "after-retirement", signedAtMs: 1_800_000_000_000)
            }

            // Same native device and requested scopes; the replacement socket accepts read only.
            // A previously issued token stays in storage but is not this socket's credential.
            fixture.acceptedOperatorScopes = ["operator.read"]
            try await self.connect(gateway, fixture: fixture, options: options)
            let second = try #require(await gateway.currentRoute(ifGatewayID: gatewayID))
            #expect(second != first)
            #expect(fixture.capturedAuth(at: 1) == .init(token: nil, bootstrapToken: nil, deviceToken: nil))
            #expect(await gateway.httpResourceAuthorization(ifCurrentRoute: second)?.bearer == nil)
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)?.token == issuedToken)
            await #expect(throws: CancellationError.self) {
                _ = try await gateway.controlUIDashboardAuthorization(
                    ifCurrentRoute: first, nonce: "after-replacement", signedAtMs: 1_800_000_000_000)
            }
            let replacementAuthorization: Data
            do {
                replacementAuthorization = try await gateway.controlUIDashboardAuthorization(
                    ifCurrentRoute: second, nonce: "dashboard-second", signedAtMs: 1_800_000_000_000)
            } catch {
                Issue.record("Dashboard signing failed for the current accepted tokenless read-only replacement route")
                throw error
            }
            try self.verify(
                replacementAuthorization, identity: identity, scopes: ["operator.read"],
                token: nil, nonce: "dashboard-second")
            #expect(await gateway.controlUIDashboardLegacyCredentials(ifCurrentRoute: second) == nil)
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }

    @MainActor
    private func connect(
        _ gateway: GatewayNodeSession,
        fixture: NativeGatewayWebSocketFixture,
        options: GatewayConnectOptions) async throws
    {
        try await gateway.connect(
            url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
            onConnected: {}, onDisconnected: { _ in },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
    }

    private func verify(
        _ data: Data,
        identity: DeviceIdentity,
        scopes: [String],
        token: String?,
        nonce: String) throws
    {
        let response = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let client = try #require(response["client"] as? [String: Any])
        let auth = try #require(response["auth"] as? [String: String])
        let device = try #require(response["device"] as? [String: Any])
        #expect(client["id"] as? String == "openclaw-ios")
        #expect(client["mode"] as? String == "ui")
        #expect(auth == (token.map { ["deviceToken": $0] } ?? [:]))
        #expect(response["scopes"] as? [String] == scopes)
        #expect(device["id"] as? String == identity.deviceId)
        #expect(device["nonce"] as? String == nonce)
        #expect((device["signedAt"] as? NSNumber)?.int64Value == 1_800_000_000_000)
        let keyBytes = try #require(Data(base64Encoded: identity.publicKey))
        let exposedKey = try self.decodeBase64URL(#require(device["publicKey"] as? String))
        #expect(exposedKey == keyBytes)
        let signature = try self.decodeBase64URL(#require(device["signature"] as? String))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        let expected = "v2|\(identity.deviceId)|openclaw-ios|ui|operator|\(scopes.joined(separator: ","))|" +
            "1800000000000|\(token ?? "")|\(nonce)"
        #expect(publicKey.isValidSignature(signature, for: Data(expected.utf8)))
    }

    private func decodeBase64URL(_ value: String) throws -> Data {
        let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return try #require(Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)))
    }
}
#endif
