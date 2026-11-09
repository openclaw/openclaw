import Foundation

/// App-private node enrollment state. Never opens or upgrades a Gateway or client-credential database.
public enum OpenClawIDNodeStateSchema {
    public static let version: Int64 = 1
    public static let migrationID = "apple-node-targets-v1"

    private static let tableSQL = """
    CREATE TABLE openclaw_id_node_targets (
      hostname TEXT NOT NULL PRIMARY KEY,
      claw_id TEXT NOT NULL,
      root_fingerprint TEXT NOT NULL,
      binding_sequence INTEGER NOT NULL,
      snapshot_sequence INTEGER NOT NULL,
      snapshot_issued_at INTEGER NOT NULL,
      snapshot_binding_sequence INTEGER NOT NULL,
      enrollment_id TEXT,
      discovery_origin TEXT,
      relay_url TEXT,
      server_key TEXT,
      peer_key TEXT,
      evidence_json TEXT,
      CHECK (binding_sequence >= 1 AND snapshot_sequence >= 0 AND snapshot_issued_at >= 0
        AND snapshot_binding_sequence >= 1),
      CHECK ((enrollment_id IS NULL AND discovery_origin IS NULL AND relay_url IS NULL
        AND server_key IS NULL AND peer_key IS NULL AND evidence_json IS NULL)
        OR (enrollment_id IS NOT NULL AND discovery_origin IS NOT NULL AND relay_url IS NOT NULL
        AND server_key IS NOT NULL AND peer_key IS NOT NULL AND evidence_json IS NOT NULL))
    ) STRICT
    """

    /// The caller supplies its app-owned URL; there is deliberately no Gateway-path fallback.
    public static func open(databaseURL: URL) throws -> OpenClawNativeStateSQLite {
        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        // Anti-rollback observations must survive power loss, not only an app crash.
        try database.execute("PRAGMA synchronous = FULL")
        try database.withImmediateTransaction {
            switch try database.scalarInt64("PRAGMA user_version") {
            case 0:
                guard try database.scalarInt64("SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'") == 0
                else { throw OpenClawNativeStateError("Unrecognized node enrollment database; use its owning app") }
                try database.execute(Self.tableSQL)
                try database.execute("PRAGMA user_version = 1")
            case Self.version:
                // Admission only, never per read/write. Reject a different owner or incompatible schema.
                let query = try database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
                guard try query.step() == .row,
                      try query.requiredText(at: 0, field: "node schema") == Self.tableSQL,
                      try query.step() == .done
                else { throw OpenClawNativeStateError("Incompatible node enrollment schema; use a compatible OpenClaw app") }
            default:
                throw OpenClawNativeStateError("Update OpenClaw to open this node enrollment database")
            }
        }
        return database
    }
}
