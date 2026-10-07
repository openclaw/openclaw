import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct ControlUINativeGatewayAuthHandlerTests {
    private static func makeConfig(gatewayID: String) throws -> GatewayConnectConfig {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            stableID: "manual|gateway.example.com|8443",
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
                deviceAuthGatewayID: gatewayID))
    }

    private static func base64URLDecode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        return Data(base64Encoded: base64)
    }

    @Test func `request accepts only the exact challenge shape`() {
        let valid: [String: Any] = ["id": "a", "nonce": "n-1", "signedAt": 1_700_000_000_000]
        #expect(ControlUINativeGatewayAuthHandler.Request(valid)?.signedAt == 1_700_000_000_000)

        var extra = valid
        extra["token"] = "x"
        var pipe = valid
        pipe["nonce"] = "a|b"
        var fractional = valid
        fractional["signedAt"] = 1.5
        var negative = valid
        negative["signedAt"] = -1
        var boolean = valid
        boolean["signedAt"] = true
        var empty = valid
        empty["id"] = ""
        for body in [extra, pipe, fractional, negative, boolean, empty] as [[String: Any]] {
            #expect(ControlUINativeGatewayAuthHandler.Request(body) == nil)
        }
        #expect(ControlUINativeGatewayAuthHandler.Request("nope") == nil)
    }

    @Test func `signed result verifies against the identity and echoes the challenge`() throws {
        let gatewayID = "manual|native-auth-\(UUID().uuidString)|8443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer { DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID) }
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "device-token",
            scopes: ["operator.read", "operator.write"],
            gatewayID: gatewayID)
        let config = try Self.makeConfig(gatewayID: gatewayID)
        let request = try #require(ControlUINativeGatewayAuthHandler.Request(
            ["id": "req-1", "nonce": "nonce-1", "signedAt": 1_700_000_000_000]))

        let result = try #require(ControlUINativeGatewayAuthHandler.signedResult(
            request: request, config: config, expectedToken: "device-token"))

        let device = try #require(result["device"] as? [String: Any])
        #expect(device["nonce"] as? String == "nonce-1")
        #expect(device["signedAt"] as? Int64 == 1_700_000_000_000)
        #expect(device["id"] as? String == identity.deviceId)
        #expect((result["auth"] as? [String: String]) == ["deviceToken": "device-token"])
        #expect((result["scopes"] as? [String]) == ["operator.read", "operator.write"])
        let client = try #require(result["client"] as? [String: String])
        #expect(client["id"] == "ios")
        #expect(client["mode"] == "ui")

        // The gateway verifies this exact v2 payload with the device public key.
        let payload = "v2|\(identity.deviceId)|ios|ui|operator|operator.read,operator.write|" +
            "1700000000000|device-token|nonce-1"
        let publicKeyText = try #require(device["publicKey"] as? String)
        let signatureText = try #require(device["signature"] as? String)
        let publicKeyData = try #require(Self.base64URLDecode(publicKeyText))
        let signature = try #require(Self.base64URLDecode(signatureText))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        #expect(publicKey.isValidSignature(signature, for: Data(payload.utf8)))
        #expect(!String(describing: result).contains(identity.privateKey))
    }

    @Test func `rotated stored token refuses the challenge`() throws {
        let gatewayID = "manual|native-auth-rotated-\(UUID().uuidString)|8443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer { DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID) }
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId, role: "operator", token: "rotated-token",
            scopes: ["operator.read"], gatewayID: gatewayID)
        let config = try Self.makeConfig(gatewayID: gatewayID)
        let request = try #require(ControlUINativeGatewayAuthHandler.Request(
            ["id": "req-1", "nonce": "nonce-1", "signedAt": 1_700_000_000_000]))

        #expect(ControlUINativeGatewayAuthHandler.signedResult(
            request: request, config: config, expectedToken: "old-token") == nil)
    }
}
