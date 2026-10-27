import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct ControlUINativeGatewayAuthHandlerTests {
    private static func makeConfig(
        gatewayID: String,
        token: String? = nil,
        password: String? = nil) throws -> GatewayConnectConfig
    {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            stableID: "manual|gateway.example.com|8443",
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
                deviceAuthGatewayID: gatewayID))
    }

    private static func base64URLDecode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64 += "="
        }
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
        let request = try #require(ControlUINativeGatewayAuthHandler.Request(
            ["id": "req-1", "nonce": "nonce-1", "signedAt": 1_700_000_000_000]))
        let cases: [(GatewayAuthSource, [String: String], String)] = [
            (.deviceToken, ["deviceToken": "device-token"], "device-token"),
            (.sharedToken, ["token": "shared-token"], "shared-token"),
            (.password, ["password": "shared-password"], ""),
        ]
        for (source, expectedAuth, signatureToken) in cases {
            let config = try Self.makeConfig(
                gatewayID: gatewayID, token: "shared-token", password: "shared-password")
            let binding = GatewayAuthBinding(source: source, credentialFingerprint: nil, deviceId: identity.deviceId)
            let result = try #require(ControlUINativeGatewayAuthHandler.signedResult(
                request: request,
                config: config,
                expectedToken: "device-token",
                binding: binding,
                scopes: ["operator.read", "operator.write"]))
            let device = try #require(result["device"] as? [String: Any])
            #expect(device["nonce"] as? String == "nonce-1")
            #expect(device["signedAt"] as? Int64 == 1_700_000_000_000)
            #expect(device["id"] as? String == identity.deviceId)
            #expect((result["auth"] as? [String: String]) == expectedAuth)
            #expect((result["scopes"] as? [String]) == ["operator.read", "operator.write"])
            let client = try #require(result["client"] as? [String: String])
            #expect(client["id"] == "ios")
            #expect(client["mode"] == "ui")

            // Independently verify the v2 wire payload, including the selected credential.
            let payload = "v2|\(identity.deviceId)|ios|ui|operator|operator.read,operator.write|" +
                "1700000000000|\(signatureToken)|nonce-1"
            let publicKeyText = try #require(device["publicKey"] as? String)
            let signatureText = try #require(device["signature"] as? String)
            let publicKeyData = try #require(Self.base64URLDecode(publicKeyText))
            let signature = try #require(Self.base64URLDecode(signatureText))
            let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
            #expect(publicKey.isValidSignature(signature, for: Data(payload.utf8)))
            #expect(!String(describing: result).contains(identity.privateKey))
        }
    }

    @Test func `rotated stored token refuses the challenge`() throws {
        let gatewayID = "manual|native-auth-rotated-\(UUID().uuidString)|8443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer { DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID) }
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "rotated-token",
            scopes: ["operator.read"],
            gatewayID: gatewayID)
        let config = try Self.makeConfig(gatewayID: gatewayID)
        let request = try #require(ControlUINativeGatewayAuthHandler.Request(
            ["id": "req-1", "nonce": "nonce-1", "signedAt": 1_700_000_000_000]))

        #expect(ControlUINativeGatewayAuthHandler.signedResult(
            request: request,
            config: config,
            expectedToken: "old-token",
            binding: GatewayAuthBinding(source: .deviceToken, credentialFingerprint: nil, deviceId: identity.deviceId),
            scopes: nil) == nil)
    }
}
