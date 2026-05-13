import Foundation
import OSLog
import SQLite3

public struct OpenClawSQLiteDeviceIdentityRow: Sendable {
    public let deviceId: String
    public let publicKeyPem: String
    public let privateKeyPem: String
    public let createdAtMs: Int

    public init(deviceId: String, publicKeyPem: String, privateKeyPem: String, createdAtMs: Int) {
        self.deviceId = deviceId
        self.publicKeyPem = publicKeyPem
        self.privateKeyPem = privateKeyPem
        self.createdAtMs = createdAtMs
    }
}

public struct OpenClawSQLiteDeviceAuthTokenRow: Sendable {
    public let deviceId: String
    public let role: String
    public let token: String
    public let scopesJSON: String
    public let updatedAtMs: Int

    public init(deviceId: String, role: String, token: String, scopesJSON: String, updatedAtMs: Int) {
        self.deviceId = deviceId
        self.role = role
        self.token = token
        self.scopesJSON = scopesJSON
        self.updatedAtMs = updatedAtMs
    }
}

public struct OpenClawSQLitePortGuardianRecord: Sendable {
    public let port: Int
    public let pid: Int32
    public let command: String
    public let mode: String
    public let timestamp: TimeInterval

    public init(port: Int, pid: Int32, command: String, mode: String, timestamp: TimeInterval) {
        self.port = port
        self.pid = pid
        self.command = command
        self.mode = mode
        self.timestamp = timestamp
    }
}

public enum OpenClawSQLiteStateStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "sqlite-state")
    private static let secureStateDirPermissions = 0o700

    public static func databaseURL() -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite")
    }

    public static func tableLocationForDisplay(table: String, key: String) -> String {
        "\(self.databaseURL().path)#table/\(table)/\(key)"
    }

    public static func readDeviceIdentity(key: String = "default") -> OpenClawSQLiteDeviceIdentityRow? {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }

            let sql = """
                SELECT device_id, public_key_pem, private_key_pem, created_at_ms
                FROM device_identities
                WHERE identity_key = ?
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: key)

            let status = sqlite3_step(statement)
            if status == SQLITE_ROW,
               let deviceId = self.columnString(statement, index: 0),
               let publicKeyPem = self.columnString(statement, index: 1),
               let privateKeyPem = self.columnString(statement, index: 2)
            {
                return OpenClawSQLiteDeviceIdentityRow(
                    deviceId: deviceId,
                    publicKeyPem: publicKeyPem,
                    privateKeyPem: privateKeyPem,
                    createdAtMs: Int(sqlite3_column_int64(statement, 3)))
            }
            if status == SQLITE_DONE { return nil }
            throw self.sqliteError(db, context: "SQLite device identity read failed")
        } catch {
            self.logger.warning("SQLite device identity read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public static func writeDeviceIdentity(
        key: String = "default",
        identity: OpenClawSQLiteDeviceIdentityRow,
        updatedAtMs: Int = Int(Date().timeIntervalSince1970 * 1000)) throws
    {
        try self.withWriteTransaction { db in
            let sql = """
                INSERT INTO device_identities (
                  identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(identity_key) DO UPDATE SET
                  device_id = excluded.device_id,
                  public_key_pem = excluded.public_key_pem,
                  private_key_pem = excluded.private_key_pem,
                  created_at_ms = excluded.created_at_ms,
                  updated_at_ms = excluded.updated_at_ms
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: key)
            self.bindText(statement, index: 2, value: identity.deviceId)
            self.bindText(statement, index: 3, value: identity.publicKeyPem)
            self.bindText(statement, index: 4, value: identity.privateKeyPem)
            sqlite3_bind_int64(statement, 5, Int64(identity.createdAtMs))
            sqlite3_bind_int64(statement, 6, Int64(updatedAtMs))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw self.sqliteError(db, context: "SQLite device identity write failed")
            }
        }
    }

    public static func readDeviceAuthToken(deviceId: String, role: String) -> OpenClawSQLiteDeviceAuthTokenRow? {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }

            let sql = """
                SELECT device_id, role, token, scopes_json, updated_at_ms
                FROM device_auth_tokens
                WHERE device_id = ? AND role = ?
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: deviceId)
            self.bindText(statement, index: 2, value: role)
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW,
               let rowDeviceId = self.columnString(statement, index: 0),
               let rowRole = self.columnString(statement, index: 1),
               let token = self.columnString(statement, index: 2),
               let scopesJSON = self.columnString(statement, index: 3)
            {
                return OpenClawSQLiteDeviceAuthTokenRow(
                    deviceId: rowDeviceId,
                    role: rowRole,
                    token: token,
                    scopesJSON: scopesJSON,
                    updatedAtMs: Int(sqlite3_column_int64(statement, 4)))
            }
            if status == SQLITE_DONE { return nil }
            throw self.sqliteError(db, context: "SQLite device auth read failed")
        } catch {
            self.logger.warning("SQLite device auth read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public static func readLatestDeviceAuthDeviceId() -> String? {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }
            let sql = """
                SELECT device_id
                FROM device_auth_tokens
                ORDER BY updated_at_ms DESC, device_id ASC
                LIMIT 1
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW { return self.columnString(statement, index: 0) }
            if status == SQLITE_DONE { return nil }
            throw self.sqliteError(db, context: "SQLite device auth latest-device read failed")
        } catch {
            self.logger.warning(
                "SQLite device auth latest-device read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public static func upsertDeviceAuthToken(_ row: OpenClawSQLiteDeviceAuthTokenRow) throws {
        try self.withWriteTransaction { db in
            let sql = """
                INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(device_id, role) DO UPDATE SET
                  token = excluded.token,
                  scopes_json = excluded.scopes_json,
                  updated_at_ms = excluded.updated_at_ms
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: row.deviceId)
            self.bindText(statement, index: 2, value: row.role)
            self.bindText(statement, index: 3, value: row.token)
            self.bindText(statement, index: 4, value: row.scopesJSON)
            sqlite3_bind_int64(statement, 5, Int64(row.updatedAtMs))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw self.sqliteError(db, context: "SQLite device auth write failed")
            }
        }
    }

    public static func deleteDeviceAuthToken(deviceId: String, role: String) throws {
        try self.withWriteTransaction { db in
            let sql = "DELETE FROM device_auth_tokens WHERE device_id = ? AND role = ?"
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: deviceId)
            self.bindText(statement, index: 2, value: role)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw self.sqliteError(db, context: "SQLite device auth delete failed")
            }
        }
    }

    public static func deleteAllDeviceAuthTokens() throws {
        try self.withWriteTransaction { db in
            try self.exec(db, "DELETE FROM device_auth_tokens")
        }
    }

    public static func execApprovalsLocationForDisplay(configKey: String = "current") -> String {
        self.tableLocationForDisplay(table: "exec_approvals_config", key: configKey)
    }

    public static func readExecApprovalsRaw(configKey: String = "current") -> String? {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }
            let sql = "SELECT raw_json FROM exec_approvals_config WHERE config_key = ?"
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: configKey)
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW { return self.columnString(statement, index: 0) }
            if status == SQLITE_DONE { return nil }
            throw self.sqliteError(db, context: "SQLite exec approvals read failed")
        } catch {
            self.logger.warning("SQLite exec approvals read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public static func writeExecApprovalsConfig(
        configKey: String = "current",
        rawJSON: String,
        socketPath: String?,
        hasSocketToken: Bool,
        defaultSecurity: String?,
        defaultAsk: String?,
        defaultAskFallback: String?,
        autoAllowSkills: Bool?,
        agentCount: Int,
        allowlistCount: Int,
        updatedAtMs: Int = Int(Date().timeIntervalSince1970 * 1000)) throws
    {
        try self.withWriteTransaction { db in
            let sql = """
                INSERT INTO exec_approvals_config (
                  config_key, raw_json, socket_path, has_socket_token, default_security,
                  default_ask, default_ask_fallback, auto_allow_skills,
                  agent_count, allowlist_count, updated_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(config_key) DO UPDATE SET
                  raw_json = excluded.raw_json,
                  socket_path = excluded.socket_path,
                  has_socket_token = excluded.has_socket_token,
                  default_security = excluded.default_security,
                  default_ask = excluded.default_ask,
                  default_ask_fallback = excluded.default_ask_fallback,
                  auto_allow_skills = excluded.auto_allow_skills,
                  agent_count = excluded.agent_count,
                  allowlist_count = excluded.allowlist_count,
                  updated_at_ms = excluded.updated_at_ms
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: configKey)
            self.bindText(statement, index: 2, value: rawJSON)
            self.bindNullableText(statement, index: 3, value: socketPath)
            sqlite3_bind_int(statement, 4, hasSocketToken ? 1 : 0)
            self.bindNullableText(statement, index: 5, value: defaultSecurity)
            self.bindNullableText(statement, index: 6, value: defaultAsk)
            self.bindNullableText(statement, index: 7, value: defaultAskFallback)
            if let autoAllowSkills {
                sqlite3_bind_int(statement, 8, autoAllowSkills ? 1 : 0)
            } else {
                sqlite3_bind_null(statement, 8)
            }
            sqlite3_bind_int(statement, 9, Int32(agentCount))
            sqlite3_bind_int(statement, 10, Int32(allowlistCount))
            sqlite3_bind_int64(statement, 11, Int64(updatedAtMs))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw self.sqliteError(db, context: "SQLite exec approvals write failed")
            }
        }
    }

    public static func readPortGuardianRecords() -> [OpenClawSQLitePortGuardianRecord] {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }
            let sql = """
                SELECT port, pid, command, mode, timestamp
                FROM macos_port_guardian_records
                ORDER BY timestamp ASC, pid ASC
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            var rows: [OpenClawSQLitePortGuardianRecord] = []
            while true {
                let status = sqlite3_step(statement)
                if status == SQLITE_DONE { break }
                guard status == SQLITE_ROW else {
                    throw self.sqliteError(db, context: "SQLite port guardian read failed")
                }
                guard let command = self.columnString(statement, index: 2),
                      let mode = self.columnString(statement, index: 3)
                else { continue }
                rows.append(OpenClawSQLitePortGuardianRecord(
                    port: Int(sqlite3_column_int(statement, 0)),
                    pid: sqlite3_column_int(statement, 1),
                    command: command,
                    mode: mode,
                    timestamp: sqlite3_column_double(statement, 4)))
            }
            return rows
        } catch {
            self.logger.warning("SQLite port guardian read failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    public static func replacePortGuardianRecords(_ records: [OpenClawSQLitePortGuardianRecord]) throws {
        try self.withWriteTransaction { db in
            try self.exec(db, "DELETE FROM macos_port_guardian_records")
            for record in records {
                try self.insertPortGuardianRecord(db, record)
            }
        }
    }

    private static func openStateDatabase() throws -> OpaquePointer? {
        self.ensureSecureStateDirectory()
        let url = self.databaseURL()
        try FileManager().createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try? FileManager().setAttributes(
            [.posixPermissions: self.secureStateDirPermissions],
            ofItemAtPath: url.deletingLastPathComponent().path)

        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK
        else {
            defer { sqlite3_close(db) }
            throw self.sqliteError(db, context: "SQLite state open failed")
        }
        try self.configureStateDatabase(db)
        self.hardenStateDatabaseFiles()
        return db
    }

    private static func configureStateDatabase(_ db: OpaquePointer?) throws {
        try self.exec(db, "PRAGMA journal_mode = WAL")
        try self.exec(db, "PRAGMA synchronous = NORMAL")
        try self.exec(db, "PRAGMA busy_timeout = 30000")
        try self.exec(db, "PRAGMA foreign_keys = ON")
        try self.exec(
            db,
            """
            CREATE TABLE IF NOT EXISTS device_identities (
              identity_key TEXT NOT NULL PRIMARY KEY,
              device_id TEXT NOT NULL,
              public_key_pem TEXT NOT NULL,
              private_key_pem TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            )
            """)
        try self.exec(
            db,
            "CREATE INDEX IF NOT EXISTS idx_device_identities_device ON device_identities(device_id, updated_at_ms DESC)")
        try self.exec(
            db,
            """
            CREATE TABLE IF NOT EXISTS device_auth_tokens (
              device_id TEXT NOT NULL,
              role TEXT NOT NULL,
              token TEXT NOT NULL,
              scopes_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (device_id, role)
            )
            """)
        try self.exec(
            db,
            "CREATE INDEX IF NOT EXISTS idx_device_auth_tokens_updated ON device_auth_tokens(updated_at_ms DESC, device_id, role)")
        try self.exec(
            db,
            """
            CREATE TABLE IF NOT EXISTS exec_approvals_config (
              config_key TEXT NOT NULL PRIMARY KEY,
              raw_json TEXT NOT NULL,
              socket_path TEXT,
              has_socket_token INTEGER NOT NULL,
              default_security TEXT,
              default_ask TEXT,
              default_ask_fallback TEXT,
              auto_allow_skills INTEGER,
              agent_count INTEGER NOT NULL,
              allowlist_count INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            )
            """)
        try self.exec(
            db,
            """
            CREATE TABLE IF NOT EXISTS macos_port_guardian_records (
              pid INTEGER NOT NULL PRIMARY KEY,
              port INTEGER NOT NULL,
              command TEXT NOT NULL,
              mode TEXT NOT NULL,
              timestamp REAL NOT NULL
            )
            """)
        try self.exec(
            db,
            "CREATE INDEX IF NOT EXISTS idx_macos_port_guardian_records_port ON macos_port_guardian_records(port, timestamp DESC)")
    }

    private static func prepare(_ db: OpaquePointer?, _ sql: String, _ statement: inout OpaquePointer?) throws {
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw self.sqliteError(db, context: "SQLite state prepare failed")
        }
    }

    private static func insertPortGuardianRecord(
        _ db: OpaquePointer?,
        _ record: OpenClawSQLitePortGuardianRecord) throws
    {
        let sql = """
            INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
            VALUES (?, ?, ?, ?, ?)
            """
        var statement: OpaquePointer?
        try self.prepare(db, sql, &statement)
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int(statement, 1, record.pid)
        sqlite3_bind_int(statement, 2, Int32(record.port))
        self.bindText(statement, index: 3, value: record.command)
        self.bindText(statement, index: 4, value: record.mode)
        sqlite3_bind_double(statement, 5, record.timestamp)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw self.sqliteError(db, context: "SQLite port guardian write failed")
        }
    }

    private static func exec(_ db: OpaquePointer?, _ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errorMessage) != SQLITE_OK {
            let message = errorMessage.map { String(cString: $0) }
            sqlite3_free(errorMessage)
            throw NSError(
                domain: "OpenClawSQLiteStateStore",
                code: Int(sqlite3_errcode(db)),
                userInfo: [
                    NSLocalizedDescriptionKey: message ?? sqlite3ErrorMessage(db),
                ])
        }
    }

    private static func bindText(_ statement: OpaquePointer?, index: Int32, value: String) {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, index, value, -1, transient)
    }

    private static func bindNullableText(_ statement: OpaquePointer?, index: Int32, value: String?) {
        guard let value else {
            sqlite3_bind_null(statement, index)
            return
        }
        self.bindText(statement, index: index, value: value)
    }

    private static func columnString(_ statement: OpaquePointer?, index: Int32) -> String? {
        guard let raw = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: UnsafeRawPointer(raw).assumingMemoryBound(to: CChar.self))
    }

    private static func withWriteTransaction(_ body: (OpaquePointer?) throws -> Void) throws {
        let db = try self.openStateDatabase()
        defer { sqlite3_close(db) }

        try self.exec(db, "BEGIN IMMEDIATE")
        do {
            try body(db)
            try self.exec(db, "COMMIT")
        } catch {
            try? self.exec(db, "ROLLBACK")
            throw error
        }
        self.hardenStateDatabaseFiles()
    }

    private static func sqliteError(_ db: OpaquePointer?, context: String) -> NSError {
        NSError(
            domain: "OpenClawSQLiteStateStore",
            code: Int(sqlite3_errcode(db)),
            userInfo: [
                NSLocalizedDescriptionKey: "\(context): \(self.sqlite3ErrorMessage(db))",
            ])
    }

    private static func sqlite3ErrorMessage(_ db: OpaquePointer?) -> String {
        guard let message = sqlite3_errmsg(db) else {
            return "unknown SQLite error"
        }
        return String(cString: message)
    }

    private static func hardenStateDatabaseFiles() {
        let path = self.databaseURL().path
        for suffix in ["", "-wal", "-shm"] {
            let candidate = "\(path)\(suffix)"
            if FileManager().fileExists(atPath: candidate) {
                try? FileManager().setAttributes([.posixPermissions: 0o600], ofItemAtPath: candidate)
            }
        }
    }

    private static func ensureSecureStateDirectory() {
        let url = DeviceIdentityPaths.stateDirURL()
        do {
            try FileManager().createDirectory(at: url, withIntermediateDirectories: true)
            try FileManager().setAttributes(
                [.posixPermissions: self.secureStateDirPermissions],
                ofItemAtPath: url.path)
        } catch {
            self.logger.warning(
                "SQLite state dir permission hardening failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
