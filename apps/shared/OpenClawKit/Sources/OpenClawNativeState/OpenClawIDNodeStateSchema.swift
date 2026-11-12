import Foundation

// periphery:ignore - Mac app wiring consumes this OpenClaw ID node API (#196759).
/// App-private node enrollment state. Never opens or upgrades a Gateway or client-credential database.
public enum OpenClawIDNodeStateSchema {
    public static let version: Int64 = 1
    public static let migrationID = "apple-node-enrollments-v1"

    private static let tableSQL = """
    CREATE TABLE openclaw_id_node_targets (
      hostname TEXT NOT NULL PRIMARY KEY,
      claw_id TEXT NOT NULL,
      root_fingerprint TEXT NOT NULL,
      binding_sequence INTEGER NOT NULL,
      snapshot_sequence INTEGER NOT NULL,
      snapshot_issued_at INTEGER NOT NULL,
      snapshot_binding_sequence INTEGER NOT NULL,
      snapshot_gateway_key TEXT,
      CHECK (binding_sequence >= 1 AND snapshot_sequence >= 0 AND snapshot_issued_at >= 0
        AND snapshot_binding_sequence >= 1)
    ) STRICT
    """

    private static let enrollmentTableSQL = """
    CREATE TABLE openclaw_id_node_enrollments (
      hostname TEXT NOT NULL,
      enrollment_id TEXT NOT NULL,
      discovery_origin TEXT NOT NULL,
      relay_url TEXT NOT NULL,
      server_key TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY (hostname, enrollment_id)
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
                try database.execute(Self.enrollmentTableSQL)
                try database.execute("PRAGMA user_version = 1")
            case Self.version:
                try Self.validate(database, definitions: [Self.enrollmentTableSQL, Self.tableSQL])
            default:
                throw OpenClawNativeStateError("Update OpenClaw to open this node enrollment database")
            }
        }
        return database
    }

    private static func validate(_ database: OpenClawNativeStateSQLite, definitions: [String]) throws {
        let query = try database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
        for definition in definitions {
            guard try query.step() == .row,
                  try query.requiredText(at: 0, field: "node schema") == definition
            else { throw OpenClawNativeStateError("Incompatible node enrollment schema; use a compatible OpenClaw app")
            }
        }
        guard try query.step() == .done else {
            throw OpenClawNativeStateError("Incompatible node enrollment schema; use a compatible OpenClaw app")
        }
    }
}
