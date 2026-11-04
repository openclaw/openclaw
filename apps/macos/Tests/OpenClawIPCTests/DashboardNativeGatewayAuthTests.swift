import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

struct DashboardNativeGatewayAuthTests {
    @Test func `personal dashboard signature binds the local identity intent`() throws {
        let key = Curve25519.Signing.PrivateKey()
        let identity = DeviceIdentity(
            deviceId: SHA256.hash(data: key.publicKey.rawRepresentation).map { String(format: "%02x", $0) }.joined(),
            publicKey: key.publicKey.rawRepresentation.base64EncodedString(),
            privateKey: key.rawRepresentation.base64EncodedString(), createdAtMs: 0)
        let json = try DashboardNativeGatewayAuth.sign(
            identity: identity, credential: .deviceToken("accepted-secret"), scopes: ["operator.read"],
            nonce: "challenge", signedAt: 123,
            personalIdentity: .use(bindingId: "binding-1", profileId: "profile-1", gatewayId: "gateway-1"),
            client: ["id": "openclaw-macos", "mode": "ui", "platform": "macOS", "deviceFamily": "Mac"])
        let result = try #require(JSONSerialization.jsonObject(with: json) as? [String: Any])
        let personal = try #require(result["personalIdentity"] as? [String: Any])
        #expect(personal["gatewayId"] as? String == "gateway-1")
        #expect(personal["issuedAtMs"] as? Int == 123)
        let device = try #require(result["device"] as? [String: Any])
        let rawSignature = try #require(device["signature"] as? String)
        let padded = rawSignature.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "=="
        let signature = try #require(Data(base64Encoded: padded))
        let payload = "[\"openclaw-device-auth\",\"v4\",\"\(identity.deviceId)\",\"openclaw-macos\",\"ui\",\"operator\",[\"operator.read\"],\"123\",\"accepted-secret\",\"challenge\",\"macos\",\"mac\",[\"personal-identity\",\"tailscale\",\"use\",\"binding-1\",\"profile-1\",\"gateway-1\",\"123\"]]"
        #expect(key.publicKey.isValidSignature(signature, for: Data(payload.utf8)))
        #expect(!key.publicKey.isValidSignature(signature, for: Data(payload.replacingOccurrences(
            of: "gateway-1", with: "other-gateway").utf8)))
    }

    @Test(arguments: ["token", "password", "deviceToken"])
    func `native signature proves the challenge and exact granted scopes without exporting a key`(
        method: String) throws
    {
        let key = Curve25519.Signing.PrivateKey()
        let identity = DeviceIdentity(
            deviceId: SHA256.hash(data: key.publicKey.rawRepresentation).map { String(format: "%02x", $0) }.joined(),
            publicKey: key.publicKey.rawRepresentation.base64EncodedString(),
            privateKey: key.rawRepresentation.base64EncodedString(), createdAtMs: 0)
        let credential: DashboardNativeGatewayAuth.Credential = switch method {
        case "token": .token("accepted-secret")
        case "password": .password("accepted-secret")
        default: .deviceToken("accepted-secret")
        }
        let json = try DashboardNativeGatewayAuth.sign(
            identity: identity, credential: credential, scopes: ["operator.read"], nonce: "challenge", signedAt: 123,
            client: ["id": "openclaw-macos", "mode": "ui"])
        let result = try #require(JSONSerialization.jsonObject(with: json) as? [String: Any])
        let device = try #require(result["device"] as? [String: Any])
        let rawSignature = try #require(device["signature"] as? String)
        let padded = rawSignature.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "=="
        let signature = try #require(Data(base64Encoded: padded))
        let tokenSlot = method == "password" ? "" : "accepted-secret"
        let payload = "v2|\(identity.deviceId)|openclaw-macos|ui|operator|operator.read|123|\(tokenSlot)|challenge"
        #expect(key.publicKey.isValidSignature(signature, for: Data(payload.utf8)))
        #expect(!key.publicKey.isValidSignature(signature, for: Data(payload.replacingOccurrences(
            of: "operator.read", with: "operator.admin").utf8)))
        #expect(!key.publicKey.isValidSignature(signature, for: Data(payload.replacingOccurrences(
            of: "challenge", with: "other-challenge").utf8)))
        #expect(result["scopes"] as? [String] == ["operator.read"])
        #expect((result["auth"] as? [String: String]) == [method: "accepted-secret"])
        #expect(Set(device.keys) == ["id", "publicKey", "signature", "signedAt", "nonce"])
        #expect(!String(decoding: json, as: UTF8.self).contains(identity.privateKey))
    }

    @Test func `bridge accepts a bounded server timestamp without caller supplied authority or a local clock assumption`() {
        let valid: [String: Any] = ["id": "request", "nonce": "challenge", "signedAt": 1_800_000_000_000]
        #expect(DashboardNativeGatewayAuthRequest(valid)?.signedAt == 1_800_000_000_000)
        var skewed = valid
        skewed["signedAt"] = 123
        #expect(DashboardNativeGatewayAuthRequest(skewed)?.signedAt == 123)
        for key in ["scopes", "role", "token", "identity", "payload"] {
            var request = valid
            request[key] = "caller-authority"
            #expect(DashboardNativeGatewayAuthRequest(request) == nil)
        }
        for timestamp: Any in [true, Double.nan, Double.infinity, 1_800_000_000_000.5, 0, -1, 9_007_199_254_740_992] {
            var request = valid
            request["signedAt"] = timestamp
            #expect(DashboardNativeGatewayAuthRequest(request) == nil)
        }
        for nonce in ["", "challenge|other", String(repeating: "n", count: 1025)] {
            var request = valid
            request["nonce"] = nonce
            #expect(DashboardNativeGatewayAuthRequest(request) == nil)
        }
    }
}
