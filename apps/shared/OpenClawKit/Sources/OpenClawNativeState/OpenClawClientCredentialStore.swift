import Darwin
import Foundation
import SQLite3

/// The local credential owner; it never opens the selected Gateway database.
public final class OpenClawClientCredentialStore: @unchecked Sendable {
    public struct Identity: Codable, Equatable, Sendable {
        private enum CodingKeys: String, CodingKey {
            case key = "identity_key", deviceID = "device_id", publicKeyPEM = "public_key_pem"
            case privateKeyPEM = "private_key_pem", createdAtMs = "created_at_ms", updatedAtMs = "updated_at_ms"
        }

        public let key: String
        public let deviceID: String
        public let publicKeyPEM: String
        public let privateKeyPEM: String
        public let createdAtMs: Int64
        public let updatedAtMs: Int64

        public init(
            key: String,
            deviceID: String,
            publicKeyPEM: String,
            privateKeyPEM: String,
            createdAtMs: Int64,
            updatedAtMs: Int64)
        {
            self.key = key
            self.deviceID = deviceID
            self.publicKeyPEM = publicKeyPEM
            self.privateKeyPEM = privateKeyPEM
            self.createdAtMs = createdAtMs
            self.updatedAtMs = updatedAtMs
        }
    }

    public struct Token: Codable, Equatable, Sendable {
        private enum CodingKeys: String, CodingKey {
            case deviceID = "device_id", role, gatewayScope = "gateway_scope", token, scopesJSON = "scopes_json"
            case updatedAtMs = "updated_at_ms"
        }

        public let deviceID: String
        public let role: String
        public let gatewayScope: String?
        public let token: String
        public let scopesJSON: String
        public let updatedAtMs: Int64

        public init(
            deviceID: String,
            role: String,
            gatewayScope: String? = nil,
            token: String,
            scopesJSON: String,
            updatedAtMs: Int64)
        {
            self.deviceID = deviceID
            self.role = role
            self.gatewayScope = gatewayScope
            self.token = token
            self.scopesJSON = scopesJSON
            self.updatedAtMs = updatedAtMs
        }
    }

    public struct SocketCredentials: Codable, Equatable, Sendable {
        public let socketKey = "current"
        enum CodingKeys: String, CodingKey {
            case socketKey = "socket_key", path = "socket_path", token = "socket_token", updatedAtMs = "updated_at_ms"
        }

        public let path: String?
        public let token: String?
        public let updatedAtMs: Int64

        public init(path: String?, token: String?, updatedAtMs: Int64) {
            self.path = path
            self.token = token
            self.updatedAtMs = updatedAtMs
        }
    }

    let rootURL: URL

    private struct AdmissionKey: Hashable {
        let device: dev_t
        let inode: ino_t
        let birthSeconds: Int
        let birthNanoseconds: Int
        let schemaVersion: Int64
    }

    private static let admissionLock = NSLock()
    private nonisolated(unsafe) static var admitted = Set<AdmissionKey>()
    private let connectionLock = NSRecursiveLock()
    private var database: OpaquePointer?

    public static func databaseURL(rootURL: URL) -> URL {
        rootURL.appendingPathComponent("client", isDirectory: true)
            .appendingPathComponent("credentials.sqlite")
    }

    /// POSIX identity for owner routing, including roots not created yet. Foundation
    /// URL resolution preserves macOS's /var alias, which SQLite NOFOLLOW rejects.
    public static func canonicalPath(_ url: URL) throws -> String {
        var ancestor = url
        var missing: [String] = []
        while true {
            if let resolved = realpath(ancestor.path, nil) {
                defer { free(resolved) }
                return missing.reduce(String(cString: resolved)) {
                    ($0 as NSString).appendingPathComponent($1)
                }
            }
            guard errno == ENOENT else {
                throw OpenClawNativeStateError("Could not resolve local client credential path")
            }
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw OpenClawNativeStateError("Could not resolve local client credential root")
            }
            missing.insert(ancestor.lastPathComponent, at: 0)
            ancestor = parent
        }
    }

    /// App-absent CLI/maintenance and iOS app/extension operations acquire the same
    /// exclusive SQLite custody and close before returning. Never await in `operation`.
    public static func withExclusiveOperation<T>(
        rootURL: URL,
        createIfMissing: Bool = true,
        busyTimeoutMilliseconds: Int32 = 5000,
        operation: (OpenClawClientCredentialStore) throws -> T) throws -> T?
    {
        if !createIfMissing, !FileManager.default.fileExists(atPath: self.databaseURL(rootURL: rootURL).path) {
            return nil
        }
        let owner = try self.init(
            rootURL: rootURL,
            createIfMissing: createIfMissing,
            busyTimeoutMilliseconds: busyTimeoutMilliseconds)
        defer { owner.close() }
        return try operation(owner)
    }

    /// Opens physical custody for one bounded operation. The active macOS app keeps
    /// its logical root ownership between operations; clients route through it.
    /// App-absent and iOS callers use the same store and close before returning.
    public init(
        rootURL: URL,
        createIfMissing: Bool = true,
        busyTimeoutMilliseconds: Int32 = 5000,
        migration: Bool = false) throws
    {
        self.rootURL = rootURL
        let url = Self.databaseURL(rootURL: rootURL)
        try Self.prepare(url: url, createIfMissing: createIfMissing)
        // System temporary roots may contain an ancestor symlink (/var on macOS).
        // The credential directory and file were checked without following links.
        let canonicalPath = try Self.canonicalPath(url)
        var opened: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW
        let result = sqlite3_open_v2(canonicalPath, &opened, flags, nil)
        guard result == SQLITE_OK, let opened else {
            if let opened {
                sqlite3_close(opened)
            }
            throw OpenClawNativeStateError("Could not open local client credentials (SQLite \(result))")
        }
        self.database = opened
        do {
            guard sqlite3_busy_timeout(opened, max(0, busyTimeoutMilliseconds)) == SQLITE_OK else {
                throw self.failure("set credential custody timeout")
            }
            guard try self.scalarText("PRAGMA journal_mode") == "delete" else {
                throw OpenClawNativeStateError("Local client credentials require DELETE journal mode")
            }
            try self.execute("PRAGMA synchronous=FULL")
            try self.transaction {
                // Retain acquired custody; early exclusive mode lets competing openers retain shared locks.
                try self.execute("PRAGMA locking_mode=EXCLUSIVE")
                try OpenClawNativeStateAdmission.assertDatabaseHasNotMoved(opened)
                let version = try self.scalarInteger("PRAGMA user_version")
                var initialized = false
                if version == 0, try self.scalarInteger(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 0
                {
                    guard createIfMissing else {
                        throw OpenClawNativeStateError("Local client credentials have not been initialized")
                    }
                    for statement in OpenClawClientCredentialSchema.statements {
                        try self.execute(statement)
                    }
                    try self.execute("PRAGMA user_version=1")
                    initialized = true
                } else if version != OpenClawClientCredentialSchema.version {
                    throw OpenClawNativeStateError(
                        "Local client credentials use unsupported schema version \(version); " +
                            "use a compatible OpenClaw build")
                }
                var info = stat()
                guard lstat(url.path, &info) == 0 else {
                    throw OpenClawNativeStateError("Local client credentials disappeared during admission")
                }
                let key = try AdmissionKey(
                    device: info.st_dev,
                    inode: info.st_ino,
                    birthSeconds: info.st_birthtimespec.tv_sec,
                    birthNanoseconds: info.st_birthtimespec.tv_nsec,
                    schemaVersion: self.scalarInteger("PRAGMA schema_version"))
                if !Self.admissionLock.withLock({ Self.admitted.contains(key) }) {
                    if !initialized {
                        try self.validateSchema()
                        guard try self.scalarText("PRAGMA quick_check(1)") == "ok" else {
                            throw OpenClawNativeStateError("Local client credential integrity check failed")
                        }
                    }
                    _ = Self.admissionLock.withLock { Self.admitted.insert(key) }
                }
            }
            if !migration {
                try assertReady(rootURL: rootURL)
            }
        } catch {
            self.close()
            throw error
        }
    }

    deinit { self.close() }

    public func close() {
        self.connectionLock.withLock {
            if let database = self.database {
                sqlite3_close(database)
                self.database = nil
            }
        }
    }

    public func readIdentity(key: String) throws -> Identity? {
        try self.transaction { try self.identity(key: key) }
    }

    /// Concurrent first creation returns the persisted winner, never the losing key.
    public func createIdentity(_ candidate: Identity) throws -> Identity {
        try self.transaction {
            if let existing = try self.identity(key: candidate.key) {
                return existing
            }
            try self.run(
                "INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)",
                [
                    .text(candidate.key),
                    .text(candidate.deviceID),
                    .text(candidate.publicKeyPEM),
                    .text(candidate.privateKeyPEM),
                    .integer(candidate.createdAtMs),
                    .integer(candidate.updatedAtMs),
                ])
            return candidate
        }
    }

    public func readToken(deviceID: String, role: String, gatewayScope: String? = nil) throws -> Token? {
        try self.transaction { try self.cachedToken(deviceID: deviceID, role: role, gatewayScope: gatewayScope) }
    }

    /// A refresh replaces only the token observed by its caller; nil means absent.
    public func replaceToken(_ token: Token, expectedToken: String?) throws -> Bool {
        try self.transaction {
            let current = try self.cachedToken(
                deviceID: token.deviceID, role: token.role, gatewayScope: token.gatewayScope)
            guard Self.sameUTF8Bytes(current?.token, expectedToken)
            else { return false }
            let columns = "device_id, role, token, scopes_json, updated_at_ms"
            let update = "token=excluded.token, scopes_json=excluded.scopes_json, updated_at_ms=excluded.updated_at_ms"
            var values: [Value] = [
                .text(token.deviceID), .text(token.role), .text(token.token),
                .text(token.scopesJSON), .integer(token.updatedAtMs),
            ]
            if let scope = token.gatewayScope {
                values.insert(.text(scope), at: 0)
                try self.run(
                    "INSERT INTO gateway_origin_device_tokens (gateway_scope, \(columns)) VALUES (?, ?, ?, ?, ?, ?) " +
                        "ON CONFLICT(gateway_scope, device_id, role) DO UPDATE SET \(update)", values)
            } else {
                try self.run(
                    "INSERT INTO device_auth_tokens (\(columns)) VALUES (?, ?, ?, ?, ?) " +
                        "ON CONFLICT(device_id, role) DO UPDATE SET \(update)", values)
            }
            return true
        }
    }

    public func removeToken(
        deviceID: String, role: String, gatewayScope: String? = nil, observedToken: String) throws -> Bool
    {
        try self.transaction {
            let (table, predicate, values) = Self.tokenKey(deviceID: deviceID, role: role, gatewayScope: gatewayScope)
            try self.run("DELETE FROM \(table) WHERE \(predicate) AND token=?", values + [.text(observedToken)])
            return try sqlite3_changes(self.connection()) != 0
        }
    }

    public func readSocketCredentials() throws -> SocketCredentials? {
        try self.transaction { try self.socketCredentials() }
    }

    public func createSocketCredentials(_ candidate: SocketCredentials) throws -> SocketCredentials {
        try self.transaction {
            if let existing = try self.socketCredentials() {
                return existing
            }
            try self.run(
                "INSERT INTO native_exec_socket_credentials VALUES ('current', ?, ?, ?)",
                [
                    candidate.path.map(Value.text) ?? .null,
                    candidate.token.map(Value.text) ?? .null,
                    .integer(candidate.updatedAtMs),
                ])
            return candidate
        }
    }

    /// Restored backups may retain the path while redacting the token to NULL.
    public func replaceSocketCredentials(_ candidate: SocketCredentials, expectedToken: String?) throws -> Bool {
        try self.transaction {
            guard try Self.sameUTF8Bytes(self.socketCredentials()?.token, expectedToken) else { return false }
            try self.run(
                "INSERT INTO native_exec_socket_credentials VALUES ('current', ?, ?, ?) " +
                    "ON CONFLICT(socket_key) DO UPDATE SET socket_path=excluded.socket_path, " +
                    "socket_token=excluded.socket_token, updated_at_ms=excluded.updated_at_ms",
                [
                    candidate.path.map(Value.text) ?? .null,
                    candidate.token.map(Value.text) ?? .null,
                    .integer(candidate.updatedAtMs),
                ])
            return true
        }
    }

    static func sameUTF8Bytes(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): true
        case let (lhs?, rhs?): lhs.utf8.elementsEqual(rhs.utf8)
        default: false
        }
    }

    private func identity(key: String) throws -> Identity? {
        try self.query(
            "SELECT device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms " +
                "FROM device_identities WHERE identity_key=?", [.text(key)])
        { statement in
            try Identity(
                key: key,
                deviceID: Self.text(statement, 0),
                publicKeyPEM: Self.text(statement, 1),
                privateKeyPEM: Self.text(statement, 2),
                createdAtMs: sqlite3_column_int64(statement, 3),
                updatedAtMs: sqlite3_column_int64(statement, 4))
        }
    }

    private static func tokenKey(deviceID: String, role: String, gatewayScope: String?)
        -> (String, String, [Value])
    {
        let values: [Value] = [.text(deviceID), .text(role)]
        if let gatewayScope {
            return (
                "gateway_origin_device_tokens", "device_id=? AND role=? AND gateway_scope=?",
                values + [.text(gatewayScope)])
        }
        return ("device_auth_tokens", "device_id=? AND role=?", values)
    }

    private func cachedToken(deviceID: String, role: String, gatewayScope: String?) throws -> Token? {
        let (table, predicate, values) = Self.tokenKey(deviceID: deviceID, role: role, gatewayScope: gatewayScope)
        return try self.query("SELECT token, scopes_json, updated_at_ms FROM \(table) WHERE \(predicate)", values) {
            try Token(
                deviceID: deviceID,
                role: role,
                gatewayScope: gatewayScope,
                token: Self.text($0, 0),
                scopesJSON: Self.text($0, 1),
                updatedAtMs: sqlite3_column_int64($0, 2))
        }
    }

    private func socketCredentials() throws -> SocketCredentials? {
        try self.query(
            "SELECT socket_path, socket_token, updated_at_ms FROM native_exec_socket_credentials " +
                "WHERE socket_key='current'")
        {
            try SocketCredentials(
                path: sqlite3_column_type($0, 0) == SQLITE_NULL ? nil : Self.text($0, 0),
                token: sqlite3_column_type($0, 1) == SQLITE_NULL ? nil : Self.text($0, 1),
                updatedAtMs: sqlite3_column_int64($0, 2))
        }
    }

    func transaction<T>(_ operation: () throws -> T) throws -> T {
        try self.connectionLock.withLock {
            if try sqlite3_get_autocommit(self.connection()) == 0 {
                return try operation()
            }
            try OpenClawNativeStateSQLite.assertNoOfflineMaintenance(
                databaseURL: self.rootURL.appendingPathComponent("state/openclaw.sqlite"))
            try self.execute("BEGIN EXCLUSIVE")
            do {
                let result = try operation()
                try Task.checkCancellation()
                try OpenClawNativeStateSQLite.assertNoOfflineMaintenance(
                    databaseURL: self.rootURL.appendingPathComponent("state/openclaw.sqlite"))
                try self.execute("COMMIT")
                return result
            } catch {
                try? self.execute("ROLLBACK")
                throw error
            }
        }
    }

    enum Value {
        case text(String), integer(Int64), null
    }

    private func connection() throws -> OpaquePointer {
        guard let database else { throw OpenClawNativeStateError("Local client credential custody was released") }
        return database
    }

    private func failure(_ operation: String) -> OpenClawNativeStateError {
        let code = self.database.map(sqlite3_errcode)
        return OpenClawNativeStateError(
            "Could not \(operation) for local client credentials",
            code: code == SQLITE_BUSY || code == SQLITE_LOCKED ? .busy : .failure)
    }

    func execute(_ sql: String) throws {
        guard try sqlite3_exec(self.connection(), sql, nil, nil, nil) == SQLITE_OK else {
            throw self.failure("execute owner operation")
        }
    }

    func withStatement<T>(_ sql: String, _ values: [Value], _ body: (OpaquePointer) throws -> T) throws -> T {
        var statement: OpaquePointer?
        guard try sqlite3_prepare_v2(self.connection(), sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw self.failure("prepare owner operation")
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result = switch value {
            case let .text(text): sqlite3_bind_text(statement, index, text, -1, transient)
            case let .integer(number): sqlite3_bind_int64(statement, index, number)
            case .null: sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else { throw self.failure("bind owner input") }
        }
        return try body(statement)
    }

    func run(_ sql: String, _ values: [Value]) throws {
        try self.withStatement(sql, values) {
            guard sqlite3_step($0) == SQLITE_DONE else { throw self.failure("write owner operation") }
        }
    }

    func query<T>(_ sql: String, _ values: [Value] = [], _ read: (OpaquePointer) throws -> T) throws -> T? {
        try self.withStatement(sql, values) {
            let result = sqlite3_step($0)
            if result == SQLITE_DONE {
                return nil
            }
            guard result == SQLITE_ROW else { throw self.failure("read owner operation") }
            return try read($0)
        }
    }

    static func text(_ statement: OpaquePointer, _ column: Int32) throws -> String {
        guard sqlite3_column_type(statement, column) == SQLITE_TEXT, let text = sqlite3_column_text(statement, column)
        else { throw OpenClawNativeStateError("Invalid local client credential text") }
        return String(cString: text)
    }

    private func scalarText(_ sql: String) throws -> String? {
        try self.query(sql) { try Self.text($0, 0) }
    }

    private func scalarInteger(_ sql: String) throws -> Int64 {
        guard let result = try query(sql, [], { sqlite3_column_int64($0, 0) }) else {
            throw self.failure("read owner metadata")
        }
        return result
    }

    private func validateSchema() throws {
        let normalize: (String) -> String = { $0.filter { !$0.isWhitespace && $0 != ";" } }
        let expected = Set(OpenClawClientCredentialSchema.statements.map(normalize))
        var observed = Set<String>()
        try withStatement("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'", []) {
            while true {
                let result = sqlite3_step($0)
                if result == SQLITE_DONE {
                    break
                }
                guard result == SQLITE_ROW else { throw self.failure("inspect owner schema") }
                try observed.insert(normalize(Self.text($0, 0)))
            }
        }
        guard observed == expected else {
            throw OpenClawNativeStateError("Local client credential schema does not match version 1")
        }
    }

    private static func prepare(url: URL, createIfMissing: Bool) throws {
        let directory = url.deletingLastPathComponent()
        if createIfMissing {
            try FileManager.default.createDirectory(
                at: directory.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            // FileManager applies attributes after mkdir; another first writer must
            // never observe the credential directory before it becomes private.
            guard mkdir(directory.path, 0o700) == 0 || errno == EEXIST else {
                throw OpenClawNativeStateError("Could not create local client credential directory")
            }
        }
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(),
              info.st_mode & 0o077 == 0
        else { throw OpenClawNativeStateError("Local client credential directory is missing or unsafe") }
        try OpenClawNativeStateSQLite.secureDirectory(directory)
        if lstat(url.path, &info) != 0, errno == ENOENT, createIfMissing {
            let descriptor = open(url.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o600)
            if descriptor >= 0 {
                Darwin.close(descriptor)
            } else if errno != EEXIST {
                throw OpenClawNativeStateError("Could not create local client credentials")
            }
        }
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(),
              info.st_mode & 0o077 == 0, info.st_nlink == 1
        else { throw OpenClawNativeStateError("Local client credential file is missing or unsafe") }
        try OpenClawNativeStateSQLite.secureDatabaseFiles(url)
    }
}
