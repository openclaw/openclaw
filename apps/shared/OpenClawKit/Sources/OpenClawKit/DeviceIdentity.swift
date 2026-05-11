import CryptoKit
import Foundation

public struct DeviceIdentity: Codable, Sendable {
    public var deviceId: String
    public var publicKey: String
    public var privateKey: String
    public var createdAtMs: Int

    public init(deviceId: String, publicKey: String, privateKey: String, createdAtMs: Int) {
        self.deviceId = deviceId
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.createdAtMs = createdAtMs
    }
}

enum DeviceIdentityPaths {
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]
    #if DEBUG
    nonisolated(unsafe) static var testingStateDirURL: URL?
    #endif

    static func stateDirURL() -> URL {
        #if DEBUG
        if let testingStateDirURL {
            return testingStateDirURL
        }
        #endif

        for key in self.stateDirEnv {
            if let raw = getenv(key) {
                let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return URL(fileURLWithPath: value, isDirectory: true)
                }
            }
        }

        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw", isDirectory: true)
    }
}

public enum DeviceIdentityStore {
    private static let identityKey = "default"
    private static let ed25519SPKIPrefix = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x70, 0x03, 0x21, 0x00,
    ])
    private static let ed25519PKCS8PrivatePrefix = Data([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])

    public static func loadOrCreate() -> DeviceIdentity {
        if let row = OpenClawSQLiteStateStore.readDeviceIdentity(key: self.identityKey) {
            switch self.decodeStoredIdentity(self.storedIdentity(from: row)) {
            case .identity(let decoded):
                return decoded
            case .recognizedInvalid:
                preconditionFailure("Stored OpenClaw device identity is invalid. Run openclaw doctor --fix.")
            }
        }
        if self.legacyIdentityMigrationRequired() {
            preconditionFailure(
                "Legacy OpenClaw device identity exists at \(self.legacyIdentityURL().path). " +
                    "Run openclaw doctor --fix before starting runtime.")
        }
        let identity = self.generate()
        self.save(identity)
        return identity
    }

    static func legacyIdentityMigrationRequired() -> Bool {
        FileManager.default.fileExists(atPath: self.legacyIdentityURL().path)
    }

    private static func legacyIdentityURL() -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
    }

    private enum DecodeResult {
        case identity(DeviceIdentity)
        case recognizedInvalid
    }

    private static func storedIdentity(from row: OpenClawSQLiteDeviceIdentityRow) -> StoredDeviceIdentity {
        StoredDeviceIdentity(
            version: 1,
            deviceId: row.deviceId,
            publicKeyPem: row.publicKeyPem,
            privateKeyPem: row.privateKeyPem,
            createdAtMs: row.createdAtMs)
    }

    private static func decodeStoredIdentity(_ decoded: StoredDeviceIdentity) -> DecodeResult {
        guard decoded.version == 1,
              let publicKeyData = self.rawPublicKey(fromPEM: decoded.publicKeyPem),
              let privateKeyData = self.rawPrivateKey(fromPEM: decoded.privateKeyPem),
              self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
        else {
            return .recognizedInvalid
        }
        return .identity(DeviceIdentity(
            deviceId: self.deviceId(publicKeyData: publicKeyData),
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: decoded.createdAtMs))
    }

    public static func signPayload(_ payload: String, identity: DeviceIdentity) -> String? {
        guard let privateKeyData = Data(base64Encoded: identity.privateKey) else { return nil }
        do {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
            let signature = try privateKey.signature(for: Data(payload.utf8))
            return self.base64UrlEncode(signature)
        } catch {
            return nil
        }
    }

    private static func generate() -> DeviceIdentity {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey
        let publicKeyData = publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = self.deviceId(publicKeyData: publicKeyData)
        return DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: Int(Date().timeIntervalSince1970 * 1000))
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        let base64 = data.base64EncodedString()
        return base64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func publicKeyBase64Url(_ identity: DeviceIdentity) -> String? {
        guard let data = Data(base64Encoded: identity.publicKey) else { return nil }
        return self.base64UrlEncode(data)
    }

    private static func rawPublicKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519SPKIPrefix.count + 32,
              der.prefix(self.ed25519SPKIPrefix.count) == self.ed25519SPKIPrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func rawPrivateKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519PKCS8PrivatePrefix.count + 32,
              der.prefix(self.ed25519PKCS8PrivatePrefix.count) == self.ed25519PKCS8PrivatePrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func keyPairMatches(publicKeyData: Data, privateKeyData: Data) -> Bool {
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
        else {
            return false
        }
        return privateKey.publicKey.rawRepresentation == publicKeyData
    }

    private static func derData(fromPEM pem: String) -> Data? {
        let body = pem
            .split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }

    private static func pem(label: String, der: Data) -> String {
        let chunks = stride(from: 0, to: der.count, by: 48)
            .map { offset -> String in
                let end = min(offset + 48, der.count)
                return der.subdata(in: offset..<end).base64EncodedString()
            }
            .joined(separator: "\n")
        return "-----BEGIN \(label)-----\n\(chunks)\n-----END \(label)-----\n"
    }

    private static func deviceId(publicKeyData: Data) -> String {
        SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
    }

    private static func save(_ identity: DeviceIdentity) {
        do {
            let stored = self.storedIdentity(from: identity)
            try OpenClawSQLiteStateStore.writeDeviceIdentity(
                key: self.identityKey,
                identity: OpenClawSQLiteDeviceIdentityRow(
                    deviceId: stored.deviceId,
                    publicKeyPem: stored.publicKeyPem,
                    privateKeyPem: stored.privateKeyPem,
                    createdAtMs: stored.createdAtMs))
        } catch {
            preconditionFailure("Failed to persist OpenClaw device identity in SQLite: \(error)")
        }
    }

    private static func storedIdentity(from identity: DeviceIdentity) -> StoredDeviceIdentity {
        guard let publicKeyData = Data(base64Encoded: identity.publicKey),
              let privateKeyData = Data(base64Encoded: identity.privateKey)
        else {
            preconditionFailure("Generated OpenClaw device identity contains invalid base64")
        }
        return StoredDeviceIdentity(
            version: 1,
            deviceId: self.deviceId(publicKeyData: publicKeyData),
            publicKeyPem: self.pem(label: "PUBLIC KEY", der: self.ed25519SPKIPrefix + publicKeyData),
            privateKeyPem: self.pem(label: "PRIVATE KEY", der: self.ed25519PKCS8PrivatePrefix + privateKeyData),
            createdAtMs: identity.createdAtMs)
    }
}

private struct StoredDeviceIdentity: Codable {
    var version: Int
    var deviceId: String
    var publicKeyPem: String
    var privateKeyPem: String
    var createdAtMs: Int
}
