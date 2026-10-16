import Darwin
import Foundation

public struct ClientCredentialReceipt: Codable, Sendable {
    public struct Source: Codable, Sendable, Equatable {
        public var kind: String
        public var engine: String
        public var identity: String
        public var generation: String
        public var sha256: String
        public var destinationVersion: Int
        public init(
            kind: String = "independent",
            engine: String,
            identity: String,
            generation: String,
            sha256: String,
            destinationVersion: Int = 1)
        {
            self.kind = kind
            self.engine = engine
            self.identity = identity
            self.generation = generation
            self.sha256 = sha256
            self.destinationVersion = destinationVersion
        }
    }

    public struct SharedFile: Codable, Sendable, Equatable {
        public var path: String
        public var dev: String
        public var ino: String

        public static func inspect(_ url: URL) throws -> Self {
            var info = stat()
            guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
                throw OpenClawNativeStateError(
                    "Credential migration source is missing; restore the matching backup or run openclaw doctor --fix")
            }
            return try Self(
                path: OpenClawClientCredentialStore.canonicalPath(url),
                dev: String(info.st_dev),
                ino: String(info.st_ino))
        }
    }

    public struct LegacyImport: Codable, Sendable { public var sha256: String? }
    public var format = 1
    public var source: Source?
    public var sharedFile: SharedFile?
    public var legacyImports: [String: LegacyImport] = [:]

    public init(source: Source? = nil, sharedFile: SharedFile? = nil) {
        self.source = source
        self.sharedFile = sharedFile
    }
}

extension OpenClawClientCredentialStore {
    public func readReceipt() throws -> (receipt: ClientCredentialReceipt, phase: String)? {
        try query("SELECT source_store, phase FROM client_credential_migration WHERE version=1") {
            let data = try Data(Self.text($0, 0).utf8)
            let receipt = try JSONDecoder().decode(ClientCredentialReceipt.self, from: data)
            let profiles = ["primary", "node", "shareExtension"]
            let allowed = Set(profiles.flatMap { ["identity:\($0)", "auth:\($0)"] })
            guard receipt.format == 1, Set(receipt.legacyImports.keys).isSubset(of: allowed),
                  receipt.source
                      .map({ ["canonical", "independent"].contains($0.kind) &&
                              ["sqlite", "postgres", "native-v0"].contains($0.engine) && $0.destinationVersion == 1
                      }) ??
                      true
            else {
                throw OpenClawNativeStateError("Client credential receipt requires a compatible OpenClaw build")
            }
            return try (receipt, Self.text($0, 1))
        }
    }

    public func writeReceipt(_ receipt: ClientCredentialReceipt, phase: String = "complete") throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let text = try String(bytes: encoder.encode(receipt), encoding: .utf8)!
        try run(
            "INSERT INTO client_credential_migration VALUES (1, ?, ?, ?) ON CONFLICT(version) DO UPDATE SET " +
                "source_store=excluded.source_store, phase=excluded.phase, updated_at_ms=excluded.updated_at_ms",
            [.text(text), .text(phase), .integer(Int64(Date().timeIntervalSince1970 * 1000))])
    }

    public func assertReady(rootURL: URL) throws {
        let sharedURL = rootURL.appendingPathComponent("state/openclaw.sqlite")
        guard let state = try readReceipt() else {
            guard !FileManager.default.fileExists(atPath: sharedURL.path) else {
                throw OpenClawNativeStateError(
                    "Client credential migration is required; run openclaw doctor --fix " +
                        "with the matching CLI before starting the app")
            }
            return
        }
        guard state.receipt.format == 1, state.phase == "complete" else {
            throw OpenClawNativeStateError(
                "Client credential migration is incomplete; run openclaw doctor --fix before starting the app")
        }
        let current = FileManager.default.fileExists(atPath: sharedURL.path)
            ? try ClientCredentialReceipt.SharedFile.inspect(sharedURL) : nil
        guard current == state.receipt.sharedFile else {
            throw OpenClawNativeStateError(
                "Client credentials do not match restored shared state; run openclaw doctor --fix")
        }
    }

    /// Imports validated local file material and consumes its logical source in one commit.
    /// The receipt remains after revocation, including when the source was absent.
    public func importLegacy(
        key: String,
        sha256: String?,
        identities: [Identity] = [],
        tokens: [Token] = []) throws -> Bool
    {
        try transaction {
            var receipt = try self.readReceipt()?.receipt ?? ClientCredentialReceipt()
            guard receipt.legacyImports[key] == nil else { return false }
            for identity in identities {
                try self.run(
                    "INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(identity_key) DO NOTHING",
                    [
                        .text(identity.key), .text(identity.deviceID), .text(identity.publicKeyPEM),
                        .text(identity.privateKeyPEM), .integer(identity.createdAtMs), .integer(identity.updatedAtMs),
                    ])
            }
            for token in tokens {
                try self.run(
                    "INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id,role) DO NOTHING",
                    [
                        .text(token.deviceID), .text(token.role), .text(token.token), .text(token.scopesJSON),
                        .integer(token.updatedAtMs),
                    ])
            }
            receipt.legacyImports[key] = .init(sha256: sha256)
            try self.writeReceipt(receipt)
            return true
        }
    }
}

extension OpenClawClientCredentialStore {
    /// Rebuild only a proven independent copy; JSON consumption survives source restores.
    public func installIndependentSource(
        identities: [Identity],
        tokens: [Token],
        authTablePresent: Bool,
        receipt: ClientCredentialReceipt) throws
    {
        try transaction {
            var next = receipt
            let previous = try self.readReceipt()?.receipt
            next.legacyImports = previous?.legacyImports ?? [:]
            if previous?.source?.kind == "independent" {
                try self.execute(
                    "DELETE FROM device_identities; DELETE FROM device_auth_tokens; " +
                        "DELETE FROM gateway_origin_device_tokens")
            } else {
                for row in identities {
                    if let current = try self.readIdentity(key: row.key), current != row {
                        throw OpenClawNativeStateError(
                            "Native identity conflicts with local credentials; sources preserved")
                    }
                }
                for row in tokens {
                    if let current = try self.readToken(deviceID: row.deviceID, role: row.role), current != row {
                        throw OpenClawNativeStateError(
                            "Native token conflicts with local credentials; sources preserved")
                    }
                }
            }
            for row in identities {
                try self.run(
                    "INSERT INTO device_identities VALUES (?,?,?,?,?,?) ON CONFLICT(identity_key) DO NOTHING",
                    [
                        .text(row.key),
                        .text(row.deviceID),
                        .text(row.publicKeyPEM),
                        .text(row.privateKeyPEM),
                        .integer(row.createdAtMs),
                        .integer(row.updatedAtMs),
                    ])
                if ["primary", "node", "shareExtension"].contains(row.key) {
                    let identityKey = "identity:\(row.key)"
                    let authKey = "auth:\(row.key)"
                    if next.legacyImports[identityKey] == nil {
                        next.legacyImports[identityKey] = .init(sha256: nil)
                    }
                    // The old identity owner can run before auth ever moves out of JSON.
                    if authTablePresent, next.legacyImports[authKey] == nil {
                        next.legacyImports[authKey] = .init(sha256: nil)
                    }
                }
            }
            for row in tokens {
                try self.run(
                    "INSERT INTO device_auth_tokens VALUES (?,?,?,?,?) ON CONFLICT(device_id,role) DO NOTHING",
                    [
                        .text(row.deviceID),
                        .text(row.role),
                        .text(row.token),
                        .text(row.scopesJSON),
                        .integer(row.updatedAtMs),
                    ])
            }
            try self.writeReceipt(next)
        }
    }
}

extension OpenClawClientCredentialStore {
    public func replaceIdentityForRepair(_ row: Identity) throws {
        try transaction {
            try self.run(
                "INSERT INTO device_identities VALUES (?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET " +
                    "device_id=excluded.device_id,public_key_pem=excluded.public_key_pem," +
                    "private_key_pem=excluded.private_key_pem,created_at_ms=excluded.created_at_ms," +
                    "updated_at_ms=excluded.updated_at_ms",
                [
                    .text(row.key),
                    .text(row.deviceID),
                    .text(row.publicKeyPEM),
                    .text(row.privateKeyPEM),
                    .integer(row.createdAtMs),
                    .integer(row.updatedAtMs),
                ])
        }
    }
}

extension ClientCredentialReceipt {
    private enum ReceiptKeys: String, CodingKey { case format, source, sharedFile, legacyImports }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: ReceiptKeys.self)
        try values.encode(self.format, forKey: .format)
        try values.encode(self.source, forKey: .source)
        try values.encode(self.sharedFile, forKey: .sharedFile)
        try values.encode(self.legacyImports, forKey: .legacyImports)
    }
}

extension ClientCredentialReceipt.LegacyImport {
    private enum ImportKeys: String, CodingKey { case sha256 }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: ImportKeys.self)
        try values.encode(sha256, forKey: .sha256)
    }
}
