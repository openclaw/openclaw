import Darwin
import Foundation
import SQLite3

/// Connection mechanics only. Store owners supply filesystem and lifecycle policy.
public class OpenClawSQLiteConnection: @unchecked Sendable {
    public enum Access: Sendable {
        case readOnly
        case readWrite(createIfMissing: Bool)
        case protectedReadWrite(createIfMissing: Bool)
    }

    private var database: OpaquePointer?
    private let connectionLock = NSRecursiveLock()

    public init(databaseURL: URL, access: Access, busyTimeoutMilliseconds: Int32 = 0) throws {
        var flags = SQLITE_OPEN_FULLMUTEX
        switch access {
        case .readOnly:
            flags |= SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW | SQLITE_OPEN_PRIVATECACHE
        case let .readWrite(create):
            flags |= SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0)
        case let .protectedReadWrite(create):
            flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW | SQLITE_OPEN_PRIVATECACHE
                | (create ? SQLITE_OPEN_CREATE : 0)
            #if os(iOS) || os(watchOS)
            flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
            #endif
        }
        // System container ancestors may be aliases. Resolve the parent only:
        // NOFOLLOW must still reject a redirected database file.
        let path: String
        if flags & SQLITE_OPEN_NOFOLLOW != 0 {
            guard let parent = realpath(databaseURL.deletingLastPathComponent().path, nil) else {
                throw OpenClawNativeStateError("SQLite parent is unavailable")
            }
            defer { free(parent) }
            path = URL(fileURLWithPath: String(cString: parent))
                .appendingPathComponent(databaseURL.lastPathComponent).path
        } else {
            path = databaseURL.path
        }
        var opened: OpaquePointer?
        let result = sqlite3_open_v2(path, &opened, flags, nil)
        guard result == SQLITE_OK, let opened else {
            let detail = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            if let opened { sqlite3_close(opened) }
            throw OpenClawNativeStateError("Could not open native state database: \(detail)")
        }
        self.database = opened
        guard sqlite3_busy_timeout(opened, max(0, busyTimeoutMilliseconds)) == SQLITE_OK else {
            let error = self.databaseError(operation: "configure SQLite busy timeout")
            self.close()
            throw error
        }
    }

    deinit {
        self.close()
    }

    /// A canonical owner closes before metadata maintenance and lease release.
    /// Statements retain the dynamic owner, so none can outlive this close.
    func close() {
        self.withConnectionLock {
            if let database = self.database {
                sqlite3_close(database)
                self.database = nil
            }
        }
    }

    public var changes: Int32 {
        self.withConnectionLock { sqlite3_changes(self.database) }
    }

    /// Reads the main file before SQL can enter WAL mode. Borrow SQLite's file:
    /// closing an independent descriptor could release another connection's locks.
    public func readMainFileHeader() throws -> Data {
        try self.withConnectionLock {
            guard let database = self.database else {
                throw OpenClawNativeStateError("SQLite connection is closed")
            }
            var file: UnsafeMutablePointer<sqlite3_file>?
            guard sqlite3_file_control(database, "main", SQLITE_FCNTL_FILE_POINTER, &file) == SQLITE_OK,
                  let file, let read = file.pointee.pMethods?.pointee.xRead
            else { throw OpenClawNativeStateError("SQLite main file is unavailable") }
            var header = Data(count: 100)
            let result = header.withUnsafeMutableBytes { read(file, $0.baseAddress, 100, 0) }
            guard result == SQLITE_OK else {
                throw OpenClawNativeStateError("Could not read SQLite main file header")
            }
            return header
        }
    }

    public func withImmediateTransaction<T>(_ body: () throws -> T) throws -> T {
        try self.withConnectionLock {
            try self.execute("BEGIN IMMEDIATE")
            var committed = false
            defer {
                if !committed { try? self.execute("ROLLBACK") }
            }
            let value = try body()
            try self.execute("COMMIT")
            committed = true
            try self.didCommit()
            return value
        }
    }

    func didCommit() throws {}

    public func prepare(_ sql: String) throws -> OpenClawNativeStateSQLiteStatement {
        try self.withConnectionLock {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(self.database, sql, -1, &statement, nil) == SQLITE_OK,
                  let statement
            else {
                throw self.databaseError(operation: "prepare SQLite statement")
            }
            return OpenClawNativeStateSQLiteStatement(connection: self, statement: statement)
        }
    }

    public func execute(_ sql: String) throws {
        try self.withConnectionLock {
            var errorMessage: UnsafeMutablePointer<CChar>?
            let result = sqlite3_exec(self.database, sql, nil, nil, &errorMessage)
            guard result == SQLITE_OK else {
                let detail = errorMessage.map { String(cString: $0) }
                    ?? String(cString: sqlite3_errmsg(self.database))
                sqlite3_free(errorMessage)
                throw OpenClawNativeStateError("SQLite operation failed: \(detail)")
            }
        }
    }

    public func scalarInt64(_ sql: String) throws -> Int64 {
        try self.withConnectionLock {
            let statement = try self.prepare(sql)
            guard try statement.step() == .row,
                  statement.valueType(at: 0) == .integer
            else {
                throw OpenClawNativeStateError("SQLite integer query did not return one integer row")
            }
            let value = statement.int64(at: 0)
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite integer query returned multiple rows")
            }
            return value
        }
    }

    public func scalarText(_ sql: String) throws -> String? {
        try self.withConnectionLock {
            let statement = try self.prepare(sql)
            if try statement.step() == .done { return nil }
            let value = try statement.requiredText(at: 0, field: "query result")
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite text query returned multiple rows")
            }
            return value
        }
    }

    public func schemaObjectExists(type: String, name: String) throws -> Bool {
        try self.withConnectionLock {
            let statement = try self.prepare(
                "SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1")
            try statement.bindText(type, at: 1)
            try statement.bindText(name, at: 2)
            if try statement.step() == .done { return false }
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite schema query returned multiple rows")
            }
            return true
        }
    }

    fileprivate func databaseError(operation: String) -> OpenClawNativeStateError {
        OpenClawNativeStateError("Could not \(operation): \(String(cString: sqlite3_errmsg(self.database)))")
    }

    func withConnectionLock<T>(_ body: () throws -> T) rethrows -> T {
        self.connectionLock.lock()
        defer { self.connectionLock.unlock() }
        return try body()
    }
}

public final class OpenClawNativeStateSQLiteStatement {
    private let connection: OpenClawSQLiteConnection
    private let statement: OpaquePointer

    fileprivate init(connection: OpenClawSQLiteConnection, statement: OpaquePointer) {
        self.connection = connection
        self.statement = statement
    }

    deinit {
        _ = self.connection.withConnectionLock { sqlite3_finalize(self.statement) }
    }

    public func step() throws -> OpenClawNativeStateSQLiteStep {
        try self.connection.withConnectionLock {
            switch sqlite3_step(self.statement) {
            case SQLITE_ROW: .row
            case SQLITE_DONE: .done
            default: throw self.connection.databaseError(operation: "step SQLite statement")
            }
        }
    }

    public func bindText(_ value: String, at index: Int32) throws {
        try self.connection.withConnectionLock {
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            guard sqlite3_bind_text(self.statement, index, value, -1, transient) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite text")
            }
        }
    }

    public func bindInt64(_ value: Int64, at index: Int32) throws {
        try self.connection.withConnectionLock {
            guard sqlite3_bind_int64(self.statement, index, value) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite integer")
            }
        }
    }

    public func bindNull(at index: Int32) throws {
        try self.connection.withConnectionLock {
            guard sqlite3_bind_null(self.statement, index) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite null")
            }
        }
    }

    public func bindDouble(_ value: Double, at index: Int32) throws {
        try self.connection.withConnectionLock {
            guard sqlite3_bind_double(self.statement, index, value) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite double")
            }
        }
    }

    public func valueType(at column: Int32) -> OpenClawNativeStateSQLiteValueType {
        self.connection.withConnectionLock {
            switch sqlite3_column_type(self.statement, column) {
            case SQLITE_INTEGER: .integer
            case SQLITE_FLOAT: .float
            case SQLITE_TEXT: .text
            case SQLITE_BLOB: .blob
            default: .null
            }
        }
    }

    public func int32(at column: Int32) -> Int32 {
        self.connection.withConnectionLock { sqlite3_column_int(self.statement, column) }
    }

    public func int64(at column: Int32) -> Int64 {
        self.connection.withConnectionLock { sqlite3_column_int64(self.statement, column) }
    }

    public func double(at column: Int32) -> Double {
        self.connection.withConnectionLock { sqlite3_column_double(self.statement, column) }
    }

    public func requiredText(at column: Int32, field: String) throws -> String {
        try self.connection.withConnectionLock {
            guard self.valueType(at: column) == .text,
                  let value = sqlite3_column_text(self.statement, column)
            else {
                throw OpenClawNativeStateError("SQLite \(field) must be text")
            }
            return String(cString: value)
        }
    }
}
