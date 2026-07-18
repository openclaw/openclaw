import Darwin
import Foundation
import SQLite3

enum DeviceIdentitySQLiteStore {
    // Keep aligned with OPENCLAW_STATE_SCHEMA_VERSION. Swift never upgrades this database.
    private static let maximumSupportedSchemaVersion: Int64 = 3
    private static let busyTimeoutMilliseconds: Int32 = 5000
    private static let maximumLegacyIdentityBytes = 64 * 1024
    private static let maximumLegacyAuthBytes = 4 * 1024 * 1024
    private static let tableName = "device_identities"
    private static let indexName = "idx_device_identities_device"

    private static let createSchemaSQL = """
    CREATE TABLE IF NOT EXISTS device_identities (
      identity_key TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_device_identities_device
      ON device_identities(device_id, updated_at_ms DESC);
    """

    private struct LegacyClaim {
        let source: DeviceIdentityPaths.LegacyIdentitySource
        let data: Data
        let snapshot: LegacyFileSnapshot
        let material: DeviceIdentityMaterial
    }

    private struct LegacyFileSnapshot: Equatable {
        let device: UInt64
        let inode: UInt64
        let size: UInt64
        let modifiedAt: Date?
    }

    private struct Column: Equatable {
        let name: String
        let type: String
        let notNull: Bool
        let primaryKeyPosition: Int32
        let hidden: Int32
    }

    static func loadOrCreate(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource]) throws -> DeviceIdentity
    {
        try self.secureDirectory(destinationStateDirURL)
        try self.secureDirectory(databaseURL.deletingLastPathComponent())
        let claims = try legacySources.compactMap { try self.claimLegacyIdentity($0) }
        try self.requireConsistentClaims(claims)
        let generatedMaterial = claims.isEmpty ? DeviceIdentityStore.generateMaterial() : nil
        let writeTimestampMs = Int64(Date().timeIntervalSince1970 * 1000)

        var database: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let openResult = sqlite3_open_v2(databaseURL.path, &database, flags, nil)
        guard openResult == SQLITE_OK, let database else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            if let database { sqlite3_close(database) }
            throw DeviceIdentityStoreError("Could not open device identity database: \(message)")
        }
        defer {
            sqlite3_close(database)
            try? self.secureDatabaseFiles(databaseURL)
        }
        guard sqlite3_busy_timeout(database, self.busyTimeoutMilliseconds) == SQLITE_OK else {
            throw self.databaseError(database, operation: "configure SQLite busy timeout")
        }
        try self.secureDatabaseFiles(databaseURL)

        try self.execute(database, sql: "BEGIN IMMEDIATE")
        var committed = false
        defer {
            if !committed {
                try? self.execute(database, sql: "ROLLBACK")
            }
        }

        try self.ensureSchema(database, allowFreshCreation: true)
        let existing = try self.readIdentity(database, key: profile.rawValue)
        let selected: DeviceIdentityMaterial
        if let existing {
            if let migrated = claims.first?.material,
               !self.hasSameKeyMaterial(migrated, existing)
            {
                throw DeviceIdentityStoreError(
                    "Legacy device identity conflicts with SQLite identity key \(profile.rawValue); source preserved")
            }
            selected = existing
        } else {
            guard let candidate = claims.first?.material ?? generatedMaterial else {
                throw DeviceIdentityStoreError("Device identity candidate is unavailable")
            }
            selected = candidate
            try self.insertIdentity(
                database,
                key: profile.rawValue,
                material: selected,
                updatedAtMs: writeTimestampMs)
        }

        // The row reread under the write transaction is authoritative. Never return generated
        // or migrated key material unless SQLite reports the exact canonical receipt.
        guard let authoritative = try self.readIdentity(database, key: profile.rawValue),
              authoritative == selected
        else {
            throw DeviceIdentityStoreError("SQLite did not preserve the authoritative device identity")
        }
        try self.ensureSchema(database, allowFreshCreation: false)
        try self.execute(database, sql: "COMMIT")
        committed = true
        try self.secureDatabaseFiles(databaseURL)

        if !claims.isEmpty {
            try self.relocateLegacyAuthIfNeeded(
                claims: claims,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile)
            try self.removeClaimedLegacyIdentities(claims)
        }
        return authoritative.identity
    }

    private static func ensureSchema(_ database: OpaquePointer, allowFreshCreation: Bool) throws {
        let userVersion = try self.queryInt64(database, sql: "PRAGMA user_version")
        guard userVersion <= self.maximumSupportedSchemaVersion else {
            let message =
                "Device identity database uses newer schema version \(userVersion); " +
                "this build supports \(self.maximumSupportedSchemaVersion)"
            throw DeviceIdentityStoreError(message)
        }

        if try !self.schemaObjectExists(database, type: "table", name: self.tableName) {
            let objectCount = try self.queryInt64(
                database,
                sql: "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
            guard allowFreshCreation, userVersion == 0, objectCount == 0 else {
                throw DeviceIdentityStoreError("Nonempty OpenClaw database is missing device_identities")
            }
            try self.execute(database, sql: self.createSchemaSQL)
        }
        try self.validateDatabaseOwnership(database, userVersion: userVersion)

        let expectedColumns = [
            Column(name: "identity_key", type: "TEXT", notNull: true, primaryKeyPosition: 1, hidden: 0),
            Column(name: "device_id", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "public_key_pem", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "private_key_pem", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "created_at_ms", type: "INTEGER", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "updated_at_ms", type: "INTEGER", notNull: true, primaryKeyPosition: 0, hidden: 0),
        ]
        guard try self.tableColumns(database) == expectedColumns else {
            throw DeviceIdentityStoreError("device_identities has an incompatible schema")
        }
        let tableSQL = try self.queryText(
            database,
            sql: "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'device_identities'") ?? ""
        let normalizedTableSQL = tableSQL
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .uppercased()
        guard normalizedTableSQL.hasSuffix(") STRICT") else {
            throw DeviceIdentityStoreError("device_identities must be a STRICT table")
        }
        guard try self.validRequiredIndex(database) else {
            throw DeviceIdentityStoreError("idx_device_identities_device has an incompatible schema")
        }
    }

    private static func validateDatabaseOwnership(
        _ database: OpaquePointer,
        userVersion: Int64) throws
    {
        if userVersion == 0 {
            let statement = try self.prepare(
                database,
                sql: """
                SELECT type, name
                FROM sqlite_schema
                WHERE name NOT LIKE 'sqlite_%'
                ORDER BY type, name
                """)
            defer { sqlite3_finalize(statement) }
            var objects: [(String, String)] = []
            while true {
                let result = sqlite3_step(statement)
                if result == SQLITE_DONE { break }
                guard result == SQLITE_ROW else {
                    throw self.databaseError(database, operation: "validate Swift identity database ownership")
                }
                try objects.append((
                    self.requiredText(statement, column: 0, field: "schema object type"),
                    self.requiredText(statement, column: 1, field: "schema object name")))
            }
            guard objects.count == 2,
                  objects[0].0 == "index", objects[0].1 == self.indexName,
                  objects[1].0 == "table", objects[1].1 == self.tableName
            else {
                throw DeviceIdentityStoreError(
                    "Schema version zero database contains objects not owned by the Swift identity store")
            }
            return
        }

        let statement = try self.prepare(
            database,
            sql: "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              try self.requiredText(statement, column: 0, field: "schema role") == "global",
              sqlite3_column_type(statement, 1) == SQLITE_INTEGER,
              sqlite3_column_int64(statement, 1) == userVersion,
              sqlite3_step(statement) == SQLITE_DONE
        else {
            throw DeviceIdentityStoreError(
                "OpenClaw state database schema metadata does not match its global schema version")
        }
    }

    private static func tableColumns(_ database: OpaquePointer) throws -> [Column] {
        let statement = try self.prepare(database, sql: "PRAGMA table_xinfo('device_identities')")
        defer { sqlite3_finalize(statement) }
        var columns: [Column] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return columns }
            guard result == SQLITE_ROW else {
                throw self.databaseError(database, operation: "inspect device identity columns")
            }
            try columns.append(Column(
                name: self.requiredText(statement, column: 1, field: "column name"),
                type: self.requiredText(statement, column: 2, field: "column type").uppercased(),
                notNull: sqlite3_column_int(statement, 3) == 1,
                primaryKeyPosition: sqlite3_column_int(statement, 5),
                hidden: sqlite3_column_int(statement, 6)))
        }
    }

    private static func validRequiredIndex(_ database: OpaquePointer) throws -> Bool {
        let list = try self.prepare(database, sql: "PRAGMA index_list('device_identities')")
        defer { sqlite3_finalize(list) }
        var found = false
        while true {
            let result = sqlite3_step(list)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else {
                throw self.databaseError(database, operation: "inspect device identity indexes")
            }
            let name = try self.requiredText(list, column: 1, field: "index name")
            if name == self.indexName {
                found = sqlite3_column_int(list, 2) == 0 && sqlite3_column_int(list, 4) == 0
            }
        }
        guard found else { return false }

        let details = try self.prepare(database, sql: "PRAGMA index_xinfo('idx_device_identities_device')")
        defer { sqlite3_finalize(details) }
        var keyColumns: [(String, Bool)] = []
        while true {
            let result = sqlite3_step(details)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else {
                throw self.databaseError(database, operation: "inspect device identity index columns")
            }
            guard sqlite3_column_int(details, 5) == 1 else { continue }
            try keyColumns.append((
                self.requiredText(details, column: 2, field: "index column"),
                sqlite3_column_int(details, 3) == 1))
        }
        return keyColumns.count == 2
            && keyColumns[0].0 == "device_id" && !keyColumns[0].1
            && keyColumns[1].0 == "updated_at_ms" && keyColumns[1].1
    }

    private static func readIdentity(
        _ database: OpaquePointer,
        key: String) throws -> DeviceIdentityMaterial?
    {
        let statement = try self.prepare(
            database,
            sql: """
            SELECT device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
            FROM device_identities
            WHERE identity_key = ?
            """)
        defer { sqlite3_finalize(statement) }
        try self.bindText(statement, index: 1, value: key, database: database)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else {
            throw self.databaseError(database, operation: "read device identity")
        }
        guard sqlite3_column_type(statement, 3) == SQLITE_INTEGER,
              sqlite3_column_type(statement, 4) == SQLITE_INTEGER,
              sqlite3_column_int64(statement, 4) >= 0
        else {
            throw DeviceIdentityStoreError("SQLite device identity timestamps must be integers")
        }
        let material = try DeviceIdentityStore.material(
            deviceId: self.requiredText(statement, column: 0, field: "device_id"),
            publicKeyPEM: self.requiredText(statement, column: 1, field: "public_key_pem"),
            privateKeyPEM: self.requiredText(statement, column: 2, field: "private_key_pem"),
            createdAtMs: sqlite3_column_int64(statement, 3))
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw DeviceIdentityStoreError("SQLite returned duplicate device identity keys")
        }
        return material
    }

    private static func insertIdentity(
        _ database: OpaquePointer,
        key: String,
        material: DeviceIdentityMaterial,
        updatedAtMs: Int64) throws
    {
        let statement = try self.prepare(
            database,
            sql: """
            INSERT INTO device_identities (
              identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            """)
        defer { sqlite3_finalize(statement) }
        try self.bindText(statement, index: 1, value: key, database: database)
        try self.bindText(statement, index: 2, value: material.identity.deviceId, database: database)
        try self.bindText(statement, index: 3, value: material.publicKeyPEM, database: database)
        try self.bindText(statement, index: 4, value: material.privateKeyPEM, database: database)
        guard sqlite3_bind_int64(statement, 5, material.identity.createdAtMs) == SQLITE_OK,
              sqlite3_bind_int64(statement, 6, updatedAtMs) == SQLITE_OK
        else {
            throw self.databaseError(database, operation: "bind device identity timestamps")
        }
        guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(database) == 1 else {
            throw self.databaseError(database, operation: "insert device identity")
        }
    }

    private static func claimLegacyIdentity(
        _ source: DeviceIdentityPaths.LegacyIdentitySource) throws -> LegacyClaim?
    {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: source.identityURL.path) else {
            if (try? fileManager.destinationOfSymbolicLink(atPath: source.identityURL.path)) != nil {
                throw DeviceIdentityStoreError("Legacy device identity source must not be a symbolic link")
            }
            return nil
        }
        let before = try self.legacyFileSnapshot(
            source.identityURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyIdentityBytes)
        let data = try Data(contentsOf: source.identityURL, options: [.mappedIfSafe])
        guard data.count <= self.maximumLegacyIdentityBytes else {
            throw DeviceIdentityStoreError("Legacy device identity exceeds the maximum supported size")
        }
        let after = try self.legacyFileSnapshot(
            source.identityURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyIdentityBytes)
        guard before == after, UInt64(data.count) == before.size else {
            throw DeviceIdentityStoreError("Legacy device identity changed while being claimed")
        }
        let material = try DeviceIdentityStore.material(fromLegacyData: data)
        return LegacyClaim(source: source, data: data, snapshot: before, material: material)
    }

    private static func legacyFileSnapshot(
        _ url: URL,
        beneath rootURL: URL,
        maximumBytes: Int) throws -> LegacyFileSnapshot
    {
        try self.requireNoSymlinkTraversal(url, beneath: rootURL)
        let resourceValues = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard resourceValues.isSymbolicLink != true, resourceValues.isRegularFile == true else {
            throw DeviceIdentityStoreError("Legacy device identity source must be a regular non-symbolic file")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let linkCount = attributes[.referenceCount] as? NSNumber,
              linkCount.uint64Value == 1,
              let device = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber,
              let size = attributes[.size] as? NSNumber,
              size.uint64Value <= UInt64(maximumBytes)
        else {
            throw DeviceIdentityStoreError(
                "Legacy device identity source must be a bounded regular file with exactly one link")
        }
        return LegacyFileSnapshot(
            device: device.uint64Value,
            inode: inode.uint64Value,
            size: size.uint64Value,
            modifiedAt: attributes[.modificationDate] as? Date)
    }

    private static func requireNoSymlinkTraversal(_ url: URL, beneath rootURL: URL) throws {
        let root = rootURL.standardizedFileURL
        let candidate = url.standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPrefix) else {
            throw DeviceIdentityStoreError("Legacy device identity path escaped its state directory")
        }
        let relativePath = String(candidate.path.dropFirst(rootPrefix.count))
        let expected = root.resolvingSymlinksInPath()
            .appendingPathComponent(relativePath, isDirectory: false)
            .standardizedFileURL
        guard candidate.resolvingSymlinksInPath().standardizedFileURL == expected else {
            throw DeviceIdentityStoreError("Legacy device identity path must not traverse symbolic links")
        }
    }

    private static func requireConsistentClaims(_ claims: [LegacyClaim]) throws {
        guard let first = claims.first else { return }
        guard claims.dropFirst().allSatisfy({ self.hasSameKeyMaterial($0.material, first.material) }) else {
            throw DeviceIdentityStoreError("Legacy device identity sources conflict; all sources preserved")
        }
    }

    private static func hasSameKeyMaterial(
        _ lhs: DeviceIdentityMaterial,
        _ rhs: DeviceIdentityMaterial) -> Bool
    {
        lhs.identity.deviceId == rhs.identity.deviceId
            && lhs.identity.publicKey == rhs.identity.publicKey
            && lhs.identity.privateKey == rhs.identity.privateKey
    }

    private static func relocateLegacyAuthIfNeeded(
        claims: [LegacyClaim],
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile) throws
    {
        let fileManager = FileManager.default
        let destinationIdentityDirURL = destinationStateDirURL
            .appendingPathComponent("identity", isDirectory: true)
        let destinationAuthURL = destinationIdentityDirURL
            .appendingPathComponent(profile.authFileName, isDirectory: false)
        guard !fileManager.fileExists(atPath: destinationAuthURL.path) else { return }
        guard let source = claims
            .map(\.source)
            .first(where: {
                $0.stateDirURL.standardizedFileURL != destinationStateDirURL.standardizedFileURL
                    && fileManager.fileExists(atPath: $0.authURL.path)
            })
        else { return }

        let before = try self.legacyFileSnapshot(
            source.authURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        let data = try Data(contentsOf: source.authURL, options: [.mappedIfSafe])
        let after = try self.legacyFileSnapshot(
            source.authURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        guard before == after, UInt64(data.count) == before.size else {
            throw DeviceIdentityStoreError("Legacy device auth changed during identity migration")
        }

        // DeviceAuthStore remains file-backed. Copy it when identity ownership moves between
        // Apple containers, but never delete or rewrite the source auth file.
        try self.secureDirectory(destinationIdentityDirURL)
        let temporaryAuthURL = destinationIdentityDirURL.appendingPathComponent(
            ".\(profile.authFileName).identity-migrating-\(UUID().uuidString)",
            isDirectory: false)
        defer { try? fileManager.removeItem(at: temporaryAuthURL) }
        try data.write(to: temporaryAuthURL, options: [.atomic])
        try self.secureFile(temporaryAuthURL)

        // Publish only complete bytes, and never replace a token another process won first.
        // Foundation rejects atomic + withoutOverwriting, so use Darwin's exclusive rename.
        let renameResult = temporaryAuthURL.path.withCString { sourcePath in
            destinationAuthURL.path.withCString { destinationPath in
                renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        if renameResult != 0 {
            let renameError = errno
            guard renameError == EEXIST else {
                throw DeviceIdentityStoreError(
                    "Could not publish migrated device auth: \(String(cString: strerror(renameError)))")
            }
            return
        }
        try self.secureFile(destinationAuthURL)
    }

    private static func removeClaimedLegacyIdentities(_ claims: [LegacyClaim]) throws {
        let fileManager = FileManager.default
        for claim in claims {
            guard fileManager.fileExists(atPath: claim.source.identityURL.path) else {
                if (try? fileManager.destinationOfSymbolicLink(atPath: claim.source.identityURL.path)) != nil {
                    throw DeviceIdentityStoreError(
                        "Legacy device identity changed to a symbolic link; source preserved")
                }
                continue
            }
            let snapshot = try self.legacyFileSnapshot(
                claim.source.identityURL,
                beneath: claim.source.stateDirURL,
                maximumBytes: self.maximumLegacyIdentityBytes)
            let current = try Data(contentsOf: claim.source.identityURL, options: [.mappedIfSafe])
            guard snapshot == claim.snapshot, current == claim.data else {
                throw DeviceIdentityStoreError("Legacy device identity changed during migration; source preserved")
            }
        }
        for claim in claims where fileManager.fileExists(atPath: claim.source.identityURL.path) {
            try fileManager.removeItem(at: claim.source.identityURL)
        }
    }

    private static func schemaObjectExists(
        _ database: OpaquePointer,
        type: String,
        name: String) throws -> Bool
    {
        let statement = try self.prepare(
            database,
            sql: "SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1")
        defer { sqlite3_finalize(statement) }
        try self.bindText(statement, index: 1, value: type, database: database)
        try self.bindText(statement, index: 2, value: name, database: database)
        let result = sqlite3_step(statement)
        if result == SQLITE_ROW { return true }
        if result == SQLITE_DONE { return false }
        throw self.databaseError(database, operation: "inspect SQLite schema")
    }

    private static func queryInt64(_ database: OpaquePointer, sql: String) throws -> Int64 {
        let statement = try self.prepare(database, sql: sql)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              sqlite3_column_type(statement, 0) == SQLITE_INTEGER
        else {
            throw self.databaseError(database, operation: "read SQLite integer")
        }
        let value = sqlite3_column_int64(statement, 0)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw DeviceIdentityStoreError("SQLite integer query returned multiple rows")
        }
        return value
    }

    private static func queryText(_ database: OpaquePointer, sql: String) throws -> String? {
        let statement = try self.prepare(database, sql: sql)
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else {
            throw self.databaseError(database, operation: "read SQLite text")
        }
        let value = try self.requiredText(statement, column: 0, field: "query result")
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw DeviceIdentityStoreError("SQLite text query returned multiple rows")
        }
        return value
    }

    private static func execute(_ database: OpaquePointer, sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, sql, nil, nil, &errorMessage)
        guard result == SQLITE_OK else {
            let detail = errorMessage.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(database))
            sqlite3_free(errorMessage)
            throw DeviceIdentityStoreError("SQLite operation failed: \(detail)")
        }
    }

    private static func prepare(_ database: OpaquePointer, sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw self.databaseError(database, operation: "prepare SQLite statement")
        }
        return statement
    }

    private static func bindText(
        _ statement: OpaquePointer,
        index: Int32,
        value: String,
        database: OpaquePointer) throws
    {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, index, value, -1, transient) == SQLITE_OK else {
            throw self.databaseError(database, operation: "bind SQLite text")
        }
    }

    private static func requiredText(
        _ statement: OpaquePointer,
        column: Int32,
        field: String) throws -> String
    {
        guard sqlite3_column_type(statement, column) == SQLITE_TEXT,
              let pointer = sqlite3_column_text(statement, column)
        else {
            throw DeviceIdentityStoreError("SQLite \(field) must be text")
        }
        return String(cString: pointer)
    }

    private static func databaseError(
        _ database: OpaquePointer,
        operation: String) -> DeviceIdentityStoreError
    {
        DeviceIdentityStoreError("Could not \(operation): \(String(cString: sqlite3_errmsg(database)))")
    }

    private static func secureDirectory(_ url: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
    }

    private static func secureFile(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
    }

    private static func secureDatabaseFiles(_ databaseURL: URL) throws {
        try self.secureFile(databaseURL)
        for suffix in ["-wal", "-shm", "-journal"] {
            try self.secureFile(URL(fileURLWithPath: databaseURL.path + suffix, isDirectory: false))
        }
    }
}
