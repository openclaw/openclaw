import CryptoKit
import Foundation
import OpenClawNativeState

/// Independent native input remains untouched so the previous app can still use it.
enum NativeClientCredentialMigration {
    /// Timestamps must be exactly representable by the TypeScript credential owner.
    private static let timestampRange: ClosedRange<Int64> = 0...9_007_199_254_740_991

    private struct Rows: Encodable {
        let authTablePresent: Bool
        let identities: [OpenClawClientCredentialStore.Identity]
        let tokens: [OpenClawClientCredentialStore.Token]
    }

    static func prepare(
        root: URL,
        owner: OpenClawClientCredentialStore,
        allowIndependentSource: Bool,
        inspection: Bool = false) throws
    {
        let recorded = try owner.readReceipt()
        // A PG anchor is also version zero. A canonical binding must never reach SQLite admission here.
        if recorded?.receipt.source?.kind == "canonical" ||
            (recorded?.receipt.source == nil && recorded?.receipt.sharedFile != nil)
        {
            return
        }
        let sourceURL = root.appendingPathComponent("state/openclaw.sqlite")
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            guard recorded?.receipt.source?.kind != "independent" else {
                throw OpenClawNativeStateError(
                    "Native credential source is missing; restore it before starting the app")
            }
            return
        }
        guard allowIndependentSource || recorded?.receipt.source?.kind == "independent" else {
            throw OpenClawNativeStateError("Client credential migration requires openclaw doctor --fix")
        }
        let binding = try ClientCredentialReceipt.SharedFile.inspect(sourceURL)
        let source = try OpenClawNativeStateSQLite.readOnlyCredentialSource(
            databaseURL: URL(fileURLWithPath: binding.path))
        try source.execute("BEGIN")
        defer { try? source.execute("ROLLBACK") }
        let objects = try source.prepare("SELECT type || ':' || name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        var names = Set<String>()
        while try objects.step() == .row {
            try names.insert(objects.requiredText(at: 0, field: "schema object"))
        }
        let allowed = Set([
            "table:device_identities",
            "index:idx_device_identities_device",
            "table:device_auth_tokens",
            "index:idx_device_auth_tokens_updated",
        ])
        guard names.isSubset(of: allowed) else { throw self.unsupported() }
        let rows = try Rows(
            authTablePresent: names.contains("table:device_auth_tokens"),
            identities: self.readIdentities(source, names: names),
            tokens: self.readTokens(source, names: names))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let fingerprint = try ClientCredentialReceipt.Source(
            kind: "independent",
            engine: "native-v0",
            identity: "\(binding.dev):\(binding.ino)",
            generation: "0",
            sha256: SHA256.hash(data: encoder.encode(rows)).map { String(format: "%02x", $0) }.joined())
        guard try ClientCredentialReceipt.SharedFile.inspect(sourceURL) == binding else {
            throw OpenClawNativeStateError("Native credential source changed during import; retry")
        }
        if recorded?.receipt.source == fingerprint, recorded?.receipt.sharedFile == binding {
            return
        }
        guard !inspection else {
            throw OpenClawNativeStateError(
                "Native credentials changed; run openclaw doctor --fix " +
                    "or start a compatible app before inspecting them")
        }
        try owner.installIndependentSource(
            identities: rows.identities,
            tokens: rows.tokens,
            authTablePresent: rows.authTablePresent,
            receipt: ClientCredentialReceipt(source: fingerprint, sharedFile: binding))
    }

    private static func readIdentities(
        _ source: OpenClawNativeStateSQLite,
        names: Set<String>) throws -> [OpenClawClientCredentialStore.Identity]
    {
        var identityRows: [OpenClawClientCredentialStore.Identity] = []
        if names.contains("table:device_identities") {
            let rows = try source
                .prepare(
                    "SELECT identity_key,device_id,public_key_pem,private_key_pem,created_at_ms,updated_at_ms " +
                        "FROM device_identities ORDER BY identity_key COLLATE BINARY")
            while try rows.step() == .row {
                let row = try OpenClawClientCredentialStore.Identity(
                    key: rows.requiredText(at: 0, field: "identity key"),
                    deviceID: rows.requiredText(at: 1, field: "device id"),
                    publicKeyPEM: rows.requiredText(at: 2, field: "public key"),
                    privateKeyPEM: rows.requiredText(at: 3, field: "private key"),
                    createdAtMs: rows.int64(at: 4),
                    updatedAtMs: rows.int64(at: 5))
                guard self.timestampRange.contains(row.createdAtMs), self.timestampRange.contains(row.updatedAtMs)
                else {
                    throw OpenClawNativeStateError(
                        "Native device identity timestamps are invalid; source preserved. Run openclaw doctor --fix")
                }
                _ = try DeviceIdentityStore.material(
                    deviceId: row.deviceID,
                    publicKeyPEM: row.publicKeyPEM,
                    privateKeyPEM: row.privateKeyPEM,
                    createdAtMs: row.createdAtMs)
                identityRows.append(row)
            }
        }
        return identityRows
    }

    private static func readTokens(
        _ source: OpenClawNativeStateSQLite,
        names: Set<String>) throws -> [OpenClawClientCredentialStore.Token]
    {
        var tokenRows: [OpenClawClientCredentialStore.Token] = []
        if names.contains("table:device_auth_tokens") {
            let rows = try source
                .prepare(
                    "SELECT device_id,role,token,scopes_json,updated_at_ms " +
                        "FROM device_auth_tokens ORDER BY device_id COLLATE BINARY,role COLLATE BINARY")
            while try rows.step() == .row {
                let row = try OpenClawClientCredentialStore.Token(
                    deviceID: rows.requiredText(at: 0, field: "device id"),
                    role: rows.requiredText(at: 1, field: "role"),
                    token: rows.requiredText(at: 2, field: "token"),
                    scopesJSON: rows.requiredText(at: 3, field: "scopes"),
                    updatedAtMs: rows.int64(at: 4))
                guard self.timestampRange.contains(row.updatedAtMs), DeviceAuthStore.decodeScopes(row.scopesJSON) != nil
                else {
                    throw OpenClawNativeStateError(
                        "Native device token timestamp or scopes are invalid; source preserved. " +
                            "Run openclaw doctor --fix")
                }
                tokenRows.append(row)
            }
        }
        return tokenRows
    }

    private static func unsupported() -> OpenClawNativeStateError {
        .init("This is not a native credential-only source; run openclaw doctor --fix with the matching CLI")
    }
}
