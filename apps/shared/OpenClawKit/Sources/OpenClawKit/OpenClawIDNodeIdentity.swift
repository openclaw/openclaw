import CryptoKit
import Foundation
import Security

/// Atomic create-if-absent storage. A missing item differs from inaccessible/corrupt storage.
public protocol OpenClawIDNodeIdentityStore: Sendable {
    func loadOrCreateSeed() async throws -> Data
}

/// Device-only Keychain owner for W, separate from native pairing and owner/member identities.
public actor OpenClawIDNodeIdentityKeychainStore: OpenClawIDNodeIdentityStore {
    private let service: String
    private let account: String
    private let accessGroup: String?

    /// A dedicated per-enrollment node identity on every Apple platform, including iOS.
    /// Never reuse the phone's operator/client-pairing key or its Keychain namespace.
    public init(enrollmentID: UUID, accessGroup: String? = nil) {
        self.service = "ai.openclaw.node-enrollment"
        self.account = enrollmentID.uuidString
        self.accessGroup = accessGroup
    }

    /// Creates W only for a genuinely missing item; concurrent creators retain the winning key.
    public func loadOrCreateSeed() throws -> Data {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        if let existing = try Self.read(query) { return existing }
        var seed = Curve25519.Signing.PrivateKey().rawRepresentation
        defer { seed.resetBytes(in: 0..<seed.count) }
        var insert = query
        insert[kSecValueData as String] = seed
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw OpenClawIDNodeEnrollmentError.keychain(status)
        }
        // Read back the retained winner rather than replace an identity after a concurrent creation.
        guard let retained = try Self.read(query) else { throw OpenClawIDNodeEnrollmentError.invalidIdentity }
        return retained
    }

    private static func read(_ query: [String: Any]) throws -> Data? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw OpenClawIDNodeEnrollmentError.keychain(status) }
        guard let data = value as? Data, data.count == 32 else { throw OpenClawIDNodeEnrollmentError.invalidIdentity }
        return data
    }
}

/// Swift-owned W signing material. It is never Codable and has no public seed getter.
public struct OpenClawIDNodeIdentity: Sendable {
    private let key: Curve25519.Signing.PrivateKey
    public var peerKey: String { "iroh:" + Self.hex(key.publicKey.rawRepresentation) }
    public var signingKey: String { "ed25519:" + Self.hex(key.publicKey.rawRepresentation) }

    /// Resolves the durable identity before any enrollment mail can be sent.
    public static func loadOrCreate(store: any OpenClawIDNodeIdentityStore) async throws -> Self {
        var seed = try await store.loadOrCreateSeed()
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try Self(seed: seed)
    }

    init(seed: Data) throws {
        guard seed.count == 32 else { throw OpenClawIDNodeEnrollmentError.invalidIdentity }
        self.key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    // Module-only native adapter handoff. Never expose this to JSONL, configuration or diagnostics.
    func withNativeSeed<T>(_ body: (Data) async throws -> T) async rethrows -> T {
        // CryptoKit can share its key storage with rawRepresentation; wipe only an owned copy.
        var seed = key.rawRepresentation.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: $0.count) }
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try await body(seed)
    }

    func sign(_ input: Data) throws -> Data { try key.signature(for: input) }

    static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func unhex(_ text: String, prefix: String = "") throws -> Data {
        guard text.hasPrefix(prefix),
              OpenClawIDNodeEnrollmentLink.matches(String(text.dropFirst(prefix.count)), "^[0-9a-f]{64}$")
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        let bytes = Array(text.dropFirst(prefix.count).utf8)
        var result = Data()
        for index in stride(from: 0, to: bytes.count, by: 2) {
            guard let byte = UInt8(String(decoding: bytes[index...index + 1], as: UTF8.self), radix: 16) else {
                throw OpenClawIDNodeEnrollmentError.malformed
            }
            result.append(byte)
        }
        return result
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func decodeBase64URL(_ text: String, count: Int) throws -> Data {
        guard OpenClawIDNodeEnrollmentLink.matches(text, "^[A-Za-z0-9_-]+$"),
              let data = Data(base64Encoded: text.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)),
              data.count == count, base64URL(data) == text
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        return data
    }
}
