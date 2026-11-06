import Foundation
import OpenClawNativeState
import SQLite3

/// An unsent import, never an outbox command. Its route is captured when Share opens.
public struct SharedDraftTarget: Equatable, Sendable {
    public let gatewayID: String
    public let agentID: String
    public let sessionKey: String

    public init(gatewayID: String, agentID: String, sessionKey: String) {
        self.gatewayID = gatewayID
        self.agentID = agentID
        self.sessionKey = sessionKey
    }
}

public struct SharedDraftImport: Identifiable, Sendable {
    public let id: String
    public let target: SharedDraftTarget
    public let text: String
    public let fileNames: [String]
    public let expiresAt: Date
}

public enum SharedDraftError: Error, LocalizedError {
    case unavailable, full, missing, unreadable

    public var errorDescription: String? {
        switch self {
        case .unavailable: "Share storage is unavailable. Open OpenClaw and try again."
        case .full: "Share storage is full or exceeds 50 items or 48 MiB. Open OpenClaw to review saved shares."
        case .missing: "This saved share expired or was discarded."
        case .unreadable: "An item could not be preserved. Nothing was saved; your share is still here."
        }
    }
}

/// One small App Group database owns metadata AND original bytes. SQLite's write
/// transaction coordinates app/extension writers without filesystem manifests or
/// partially committed files. Operations run on this actor, not the UI actor.
public actor SharedDraftInbox {
    public static let maximumBytes = 48 * 1024 * 1024
    public static let maximumItems = 50
    public static let lifetime: TimeInterval = 48 * 60 * 60
    public static let shared = SharedDraftInbox()
    private let directoryURL: URL?

    public init(directoryURL: URL? = nil) {
        self.directoryURL = directoryURL
    }

    private func connection() throws -> Connection {
        let root: URL
        if let directoryURL = self.directoryURL {
            root = directoryURL
        } else {
            #if os(iOS)
            guard let group = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: OpenClawAppGroup.identifier)
            else { throw SharedDraftError.unavailable }
            root = group.appendingPathComponent("SharedDraftImports", isDirectory: true)
            #else
            throw SharedDraftError.unavailable
            #endif
        }
        return try Connection(directory: root)
    }

    public func setDestination(_ target: SharedDraftTarget?) throws {
        let db = try self.connection()
        try db.transaction {
            try db.run("DELETE FROM destination")
            if let target {
                try db.run(
                    "INSERT INTO destination VALUES (?,?,?)",
                    [target.gatewayID, target.agentID, target.sessionKey])
            }
        }
    }

    public func destination() throws -> SharedDraftTarget? {
        let db = try self.connection()
        let statement = try db.prepare("SELECT gateway,agent,session FROM destination")
        defer { sqlite3_finalize(statement) }
        guard try db.step(statement) else { return nil }
        return try db.target(statement)
    }

    /// Files are extension-owned copies, not provider URLs whose lifetime has ended.
    /// No rows become visible until every byte has been copied successfully.
    @discardableResult
    public func save(text: String, target: SharedDraftTarget, files: [URL], now: Date = Date()) throws -> String {
        guard files.count <= Self.maximumItems, text.utf8.count <= 128 * 1024,
              !text.isEmpty || !files.isEmpty
        else { throw SharedDraftError.full }
        let db = try self.connection()
        let id = UUID().uuidString
        try db.transaction {
            try db.expire(now)
            let count = try db.integer("SELECT COUNT(*) FROM imports")
            let items = try db.integer("SELECT COUNT(*) FROM attachments")
            var remaining = try Self.maximumBytes - (db.integer(
                "SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM imports")) - (db.integer(
                "SELECT COALESCE(SUM(length(bytes)),0) FROM attachments")) - text.utf8.count
            guard count < Self.maximumItems, items + files.count <= Self.maximumItems, remaining >= 0 else {
                throw SharedDraftError.full
            }
            try db.run("INSERT INTO imports VALUES (?,?,?,?,?,?)", [
                id, target.gatewayID, target.agentID, target.sessionKey, text,
                String(now.addingTimeInterval(Self.lifetime).timeIntervalSince1970),
            ])
            for (index, url) in files.enumerated() {
                let scope = url.startAccessingSecurityScopedResource()
                defer { if scope { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard url.isFileURL, values.isRegularFile == true else { throw SharedDraftError.unreadable }
                if let size = values.fileSize, size > remaining { throw SharedDraftError.full }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: remaining + 1) ?? Data()
                guard !data.isEmpty else { throw SharedDraftError.unreadable }
                guard data.count <= remaining else { throw SharedDraftError.full }
                remaining -= data.count
                try db.run(
                    "INSERT INTO attachments VALUES (?,?,?,?)",
                    [id, String(index), url.lastPathComponent],
                    data: data)
            }
        }
        return id
    }

    public func pending(now: Date = Date()) throws -> [SharedDraftImport] {
        let db = try self.connection()
        try db.expire(now)
        let statement = try db.prepare("SELECT id,gateway,agent,session,text,expires FROM imports ORDER BY expires,id")
        defer { sqlite3_finalize(statement) }
        var result: [SharedDraftImport] = []
        while try db.step(statement) {
            let id = try db.text(statement, 0)
            let names = try db.prepare("SELECT name FROM attachments WHERE import_id=? ORDER BY position")
            defer { sqlite3_finalize(names) }
            try db.bind(id, to: names, index: 1)
            var fileNames: [String] = []
            while try db.step(names) {
                try fileNames.append(db.text(names, 0))
            }
            try result.append(SharedDraftImport(
                id: id,
                target: SharedDraftTarget(
                    gatewayID: db.text(statement, 1),
                    agentID: db.text(statement, 2),
                    sessionKey: db.text(statement, 3)),
                text: db.text(statement, 4),
                fileNames: fileNames,
                expiresAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 5))))
        }
        return result
    }

    /// Temporary import artifacts are caller-owned and removed after staging or failure.
    /// The database retains original bytes until explicit discard or successful staging.
    public func materialize(id: String, into directory: URL, now: Date = Date()) throws -> [URL] {
        let db = try self.connection()
        try db.expire(now)
        return try db.transaction {
            let exists = try db.prepare("SELECT 1 FROM imports WHERE id=?")
            defer { sqlite3_finalize(exists) }
            try db.bind(id, to: exists, index: 1)
            guard try db.step(exists) else { throw SharedDraftError.missing }
            let statement = try db.prepare(
                "SELECT position,name,bytes FROM attachments WHERE import_id=? ORDER BY position")
            defer { sqlite3_finalize(statement) }
            try db.bind(id, to: statement, index: 1)
            var files: [URL] = []
            while try db.step(statement) {
                // Each item has its own directory so equal filenames remain distinct.
                let folder = directory.appendingPathComponent(
                    String(sqlite3_column_int(statement, 0)), isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let name = try (db.text(statement, 1) as NSString).lastPathComponent
                guard !name.isEmpty, name != ".", name != ".." else { throw SharedDraftError.unreadable }
                let url = folder.appendingPathComponent(name)
                guard let bytes = sqlite3_column_blob(statement, 2) else { throw SharedDraftError.unreadable }
                let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 2)))
                try data.write(to: url, options: [.atomic])
                try FileManager.default.setAttributes(Connection.privateAttributes, ofItemAtPath: url.path)
                files.append(url)
            }
            return files
        }
    }

    public func discard(id: String) throws {
        let db = try self.connection()
        try db.run("DELETE FROM imports WHERE id=?", [id])
    }
}

/// This inbox is deliberately separate from Gateway state and the auto-delivering
/// chat outbox. Raw SQLite is the bounded cross-process storage primitive here;
/// the framework's GRDB dependency belongs to Chat UI, not extension-safe Kit.
private final class Connection {
    private let db: OpaquePointer

    init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var attributes = Self.privateAttributes
        attributes[.posixPermissions] = 0o700
        try FileManager.default.setAttributes(attributes, ofItemAtPath: directory.path)
        var mutableDirectory = directory
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try mutableDirectory.setResourceValues(resourceValues)
        let url = directory.appendingPathComponent("inbox.sqlite")
        // Foundation preserves macOS aliases such as /tmp and /var. Reuse the
        // native POSIX path owner and resolve only the directory: NOFOLLOW must
        // still reject a symbolic link at the database filename itself.
        let databasePath = try (OpenClawClientCredentialStore.canonicalPath(directory) as NSString)
            .appendingPathComponent("inbox.sqlite")
        var pointer: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW
        guard sqlite3_open_v2(databasePath, &pointer, flags, nil) == SQLITE_OK, let pointer
        else {
            if let pointer { sqlite3_close(pointer) }
            throw SharedDraftError.unavailable
        }
        self.db = pointer
        sqlite3_busy_timeout(pointer, 5000)
        try self.run("PRAGMA foreign_keys=ON")
        try self.run("PRAGMA secure_delete=ON")
        try self.run("PRAGMA synchronous=FULL")
        try self.transaction {
            let version = try self.integer("PRAGMA user_version")
            guard version == 0 || version == 1 else { throw SharedDraftError.unavailable }
            if version == 0 {
                try self.run("""
                CREATE TABLE destination(
                    gateway TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL
                ) STRICT
                """)
                try self.run("""
                CREATE TABLE imports(
                    id TEXT PRIMARY KEY NOT NULL, gateway TEXT NOT NULL, agent TEXT NOT NULL,
                    session TEXT NOT NULL, text TEXT NOT NULL, expires REAL NOT NULL
                ) STRICT
                """)
                try self.run("""
                CREATE TABLE attachments(
                    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL, name TEXT NOT NULL, bytes BLOB NOT NULL,
                    PRIMARY KEY(import_id,position)
                ) STRICT
                """)
                try self.run("PRAGMA user_version=1")
            }
        }
        try FileManager.default.setAttributes(Self.privateAttributes, ofItemAtPath: url.path)
    }

    static var privateAttributes: [FileAttributeKey: Any] {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return attributes
    }

    deinit { sqlite3_close(self.db) }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try self.run("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try self.run("COMMIT")
            return result
        } catch {
            try? self.run("ROLLBACK")
            throw error
        }
    }

    func expire(_ now: Date) throws {
        try self.run("DELETE FROM imports WHERE expires<=?", [String(now.timeIntervalSince1970)])
    }

    func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(self.db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SharedDraftError.unavailable
        }
        return statement
    }

    func bind(_ value: String, to statement: OpaquePointer, index: Int32) throws {
        let result = value.withCString {
            sqlite3_bind_text(
                statement, index, $0, Int32(value.utf8.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
        guard result == SQLITE_OK else { throw SharedDraftError.unavailable }
    }

    func run(_ sql: String, _ values: [String] = [], data: Data? = nil) throws {
        let statement = try self.prepare(sql)
        defer { sqlite3_finalize(statement) }
        for (offset, value) in values.enumerated() {
            try self.bind(value, to: statement, index: Int32(offset + 1))
        }
        if let data {
            let result = data.withUnsafeBytes {
                sqlite3_bind_blob(
                    statement,
                    Int32(values.count + 1),
                    $0.baseAddress,
                    Int32(data.count),
                    unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            }
            guard result == SQLITE_OK else { throw SharedDraftError.unavailable }
        }
        // PRAGMAs may return rows; consume them before finalizing.
        while try self.step(statement) {}
    }

    func step(_ statement: OpaquePointer) throws -> Bool {
        switch sqlite3_step(statement) {
        case SQLITE_ROW: true
        case SQLITE_DONE: false
        default: throw SharedDraftError.unavailable
        }
    }

    func integer(_ sql: String) throws -> Int {
        let statement = try self.prepare(sql)
        defer { sqlite3_finalize(statement) }
        guard try self.step(statement) else { throw SharedDraftError.unavailable }
        return Int(sqlite3_column_int64(statement, 0))
    }

    func text(_ statement: OpaquePointer, _ column: Int32) throws -> String {
        // Producers bind Swift UTF-8 with an explicit byte count (including NULs).
        // Reject corrupt stored text through the existing storage error path;
        // repairing it lossily could retarget a draft or change its content.
        guard let bytes = sqlite3_column_text(statement, column),
              let value = String(
                  bytes: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_column_bytes(statement, column))),
                  encoding: .utf8)
        else { throw SharedDraftError.unavailable }
        return value
    }

    func target(_ statement: OpaquePointer) throws -> SharedDraftTarget {
        try SharedDraftTarget(
            gatewayID: self.text(statement, 0),
            agentID: self.text(statement, 1),
            sessionKey: self.text(statement, 2))
    }
}
