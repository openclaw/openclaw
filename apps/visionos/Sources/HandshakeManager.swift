//
//  HandshakeManager.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Handles the OpenClaw Gateway connect handshake:
//    1. Receive connect.challenge (nonce + ts)
//    2. Build v3 signature payload and sign with Ed25519 keypair
//    3. Send connect req frame with role:"node", caps, commands, permissions
//    4. Await hello-ok
//
//  Signature payload format (v3):
//    "v3|{deviceId}|{clientId}|{clientMode}|{role}|{scopesCsv}|{signedAtMs}|{token}|{nonce}|{platform}|{deviceFamily}"
//  Signature and public key are base64url-encoded (no padding).
//  device.id is derived: SHA-256 hex of raw Ed25519 public key bytes.
//
//  Protocol reference: https://docs.openclaw.ai/gateway/protocol
//

import Foundation
import CryptoKit
import Security
import CommonCrypto

final class HandshakeManager {

    // MARK: - Constants

    private static let clientId    = "node-host"
    private static let clientMode  = "node"
    private static let role        = "node"
    private static let platform    = "visionos"
    private static let deviceFamily = "headset"

    // MARK: - Signing key

    /// Returns a stable Ed25519 signing keypair from Keychain.
    /// On first run, generates and stores the keypair.
    static func signingKey() -> Curve25519.Signing.PrivateKey {
        let keyTag = "com.openclaw.node.signing-key"
        if let data = KeychainHelper.readData(key: keyTag),
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: data) {
            return key
        }
        let key = Curve25519.Signing.PrivateKey()
        KeychainHelper.writeData(key: keyTag, value: key.rawRepresentation)
        return key
    }

    // MARK: - Device ID (derived from public key, matches gateway expectation)

    /// Stable device ID = SHA-256 hex of raw Ed25519 public key bytes.
    /// Matches: crypto.createHash("sha256").update(rawPublicKeyBytes).digest("hex")
    static func deviceID() -> String {
        let pubKeyRaw = signingKey().publicKey.rawRepresentation
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        pubKeyRaw.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(pubKeyRaw.count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Build connect frame

    /// Builds the full connect req frame after receiving the challenge.
    /// Protocol: { type:"req", id, method:"connect", params:{ ... } }
    static func buildConnectFrame(
        nonce: String,
        ts: String,
        gatewayToken: String
    ) -> [String: Any] {
        let key = signingKey()
        let id = deviceID()
        let scopes: [String] = []
        let scopesCsv = scopes.joined(separator: ",")
        let token = gatewayToken

        // signedAtMs: current time in milliseconds (device.signedAt in the frame).
        // Gateway uses device.signedAt directly as signedAtMs in payload verification —
        // NOT the challenge ts. Must be within DEVICE_SIGNATURE_SKEW_MS of server time.
        let signedAtMs = Int64(Date().timeIntervalSince1970 * 1000)

        // Build v3 signature payload string
        // "v3|deviceId|clientId|clientMode|role|scopesCsv|signedAtMs|token|nonce|platform|deviceFamily"
        let payloadString = [
            "v3",
            id,
            clientId,
            clientMode,
            role,
            scopesCsv,
            String(signedAtMs),
            token,
            nonce,
            platform,
            deviceFamily
        ].joined(separator: "|")

        // Sign payload string bytes (not just nonce)
        let payloadData = Data(payloadString.utf8)
        let signatureB64Url: String
        if let sig = try? key.signature(for: payloadData) {
            signatureB64Url = base64UrlEncode(sig)
        } else {
            signatureB64Url = ""
        }

        // Public key: base64url-encoded raw bytes
        let publicKeyB64Url = base64UrlEncode(key.publicKey.rawRepresentation)

        let params: [String: Any] = [
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": [
                "id": clientId,
                "version": "0.1.0",
                "platform": platform,
                "deviceFamily": deviceFamily,
                "mode": clientMode
            ],
            "role": role,
            "scopes": scopes,
            "caps": [
                "spatial",
                "camera",
                "canvas",
                "location"
            ],
            "commands": [
                "camera.list",
                "camera.snap",
                "camera.clip",
                "canvas.present",
                "canvas.navigate",
                "canvas.eval",
                "canvas.snapshot",
                "canvas.hide",
                "location.get",
                "spatial.hands",
                "spatial.planes",
                "spatial.mesh",
                "device.position",
                "device.info"
            ],
            "permissions": buildPermissionsMap(),
            "auth": [
                "token": token
            ],
            "userAgent": "visionOS-node/0.1.0",
            "locale": "en-US",
            "device": [
                "id": id,
                "publicKey": publicKeyB64Url,
                "signature": signatureB64Url,
                "signedAt": signedAtMs,
                "nonce": nonce
            ]
        ]

        return [
            "type": "req",
            "id": UUID().uuidString.lowercased(),
            "method": "connect",
            "params": params
        ]
    }

    // MARK: - Permissions map

    private static func buildPermissionsMap() -> [String: Bool] {
        return [
            "camera": false,
            "handTracking": false,
            "worldSensing": false,
            "location": false,
            "microphone": false
        ]
    }

    // MARK: - Base64URL helpers

    /// Encode Data as base64url (no padding, - and _ instead of + and /)
    static func base64UrlEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - KeychainHelper

enum KeychainHelper {

    static func read(key: String) -> String? {
        guard let data = readData(key: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(key: String, value: String) {
        writeData(key: key, value: Data(value.utf8))
    }

    static func readData(key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.openclaw.node",
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    static func writeData(key: String, value: Data) {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.openclaw.node"
        ]
        let attrs: [String: Any] = [
            kSecValueData as String:      value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var add = query
            add[kSecValueData as String]      = value
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
