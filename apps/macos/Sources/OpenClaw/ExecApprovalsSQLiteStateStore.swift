import Foundation
import OSLog
import SQLite3

enum ExecApprovalsSQLiteStateStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let secureStateDirPermissions = 0o700
    private static let stateScope = "exec.approvals"
    private static let stateKey = "current"

    static func databaseURL() -> URL {
        OpenClawPaths.stateDirURL
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite")
    }

    static func storeLocationForDisplay() -> String {
        "\(self.databaseURL().path)#kv/\(self.stateScope)/\(self.stateKey)"
    }

    static func readRawState() -> String? {
        do {
            let db = try self.openStateDatabase()
            defer { sqlite3_close(db) }

            let sql = "SELECT value_json FROM kv WHERE scope = ? AND key = ?"
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }
            self.bindText(statement, index: 1, value: self.stateScope)
            self.bindText(statement, index: 2, value: self.stateKey)

            let status = sqlite3_step(statement)
            if status == SQLITE_ROW, let rawText = sqlite3_column_text(statement, 0) {
                let valueJSON = String(
                    cString: UnsafeRawPointer(rawText).assumingMemoryBound(to: CChar.self))
                return self.decodeStoredRawState(valueJSON)
            }
            if status == SQLITE_DONE {
                return nil
            }
            throw self.sqliteError(db, context: "exec approvals read failed")
        } catch {
            self.logger.warning("exec approvals SQLite read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func writeRawState(_ raw: String) throws {
        let db = try self.openStateDatabase()
        defer { sqlite3_close(db) }

        try self.exec(db, "BEGIN IMMEDIATE")
        do {
            let sql = """
                INSERT INTO kv (scope, key, value_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(scope, key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
                """
            var statement: OpaquePointer?
            try self.prepare(db, sql, &statement)
            defer { sqlite3_finalize(statement) }

            self.bindText(statement, index: 1, value: self.stateScope)
            self.bindText(statement, index: 2, value: self.stateKey)
            self.bindText(statement, index: 3, value: self.encodeStoredRawState(raw))
            sqlite3_bind_int64(statement, 4, Int64(Date().timeIntervalSince1970 * 1000))

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw self.sqliteError(db, context: "exec approvals write failed")
            }
            try self.exec(db, "COMMIT")
        } catch {
            try? self.exec(db, "ROLLBACK")
            throw error
        }
        self.hardenStateDatabaseFiles()
    }

    private static func encodeStoredRawState(_ raw: String) -> String {
        let data = (try? JSONEncoder().encode(raw)) ?? Data("\"\"".utf8)
        return String(data: data, encoding: .utf8) ?? "\"\""
    }

    private static func decodeStoredRawState(_ valueJSON: String) -> String? {
        guard let data = valueJSON.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(String.self, from: data)
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
            throw self.sqliteError(db, context: "exec approvals open failed")
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
            CREATE TABLE IF NOT EXISTS kv (
              scope TEXT NOT NULL,
              key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (scope, key)
            )
            """)
    }

    private static func prepare(_ db: OpaquePointer?, _ sql: String, _ statement: inout OpaquePointer?) throws {
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw self.sqliteError(db, context: "exec approvals prepare failed")
        }
    }

    private static func exec(_ db: OpaquePointer?, _ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errorMessage) != SQLITE_OK {
            let message = errorMessage.map { String(cString: $0) }
            sqlite3_free(errorMessage)
            throw NSError(
                domain: "OpenClawExecApprovalsSQLite",
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

    private static func sqliteError(_ db: OpaquePointer?, context: String) -> NSError {
        NSError(
            domain: "OpenClawExecApprovalsSQLite",
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
        let url = OpenClawPaths.stateDirURL
        do {
            try FileManager().createDirectory(at: url, withIntermediateDirectories: true)
            try FileManager().setAttributes(
                [.posixPermissions: self.secureStateDirPermissions],
                ofItemAtPath: url.path)
        } catch {
            self.logger.warning(
                "exec approvals state dir permission hardening failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
