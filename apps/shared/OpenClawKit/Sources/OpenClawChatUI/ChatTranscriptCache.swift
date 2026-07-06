import Foundation
import OSLog
import SQLite3
#if os(iOS)
import UIKit
#endif

private let cacheLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatTranscriptCache")

/// Read-only offline cache seam for chat sessions and transcripts.
///
/// The cache only pre-paints cold opens and covers offline browsing; connected
/// reads always come from the gateway and replace cached content wholesale.
/// Implementations must scope all rows to a single gateway identity so
/// transcripts never leak across paired gateways.
public protocol OpenClawChatTranscriptCache: Sendable {
    func loadSessions() async -> [OpenClawChatSessionEntry]
    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage]
    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async
    func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async
}

/// SQLite-backed transcript cache for one gateway identity. Owners should use
/// one database file per gateway so reset can physically remove that gateway's
/// cached transcript bytes without disturbing other paired gateways.
///
/// The cache is disposable: any open, schema, or decode mismatch drops the
/// affected state and rebuilds silently. There are no migrations.
public actor OpenClawChatSQLiteTranscriptCache: OpenClawChatTranscriptCache {
    /// Bounds keep the cache small: enough for a recently-used session picker
    /// and a full first screen of transcript, not a durable archive.
    public static let maxCachedSessions = 50
    public static let maxCachedTranscripts = 50
    public static let maxCachedMessagesPerSession = 200
    static let schemaVersion: Int32 = 1

    /// Owns the raw sqlite handle so it closes on release without needing an
    /// isolated actor deinit (OpaquePointer is not Sendable).
    private final class Connection: @unchecked Sendable {
        let raw: OpaquePointer

        init(raw: OpaquePointer) {
            self.raw = raw
        }

        deinit {
            sqlite3_close_v2(self.raw)
        }
    }

    private let databaseURL: URL
    private let gatewayID: String
    private var db: Connection?
    private var isRetired = false
    /// After a failed drop-and-rebuild the cache becomes a no-op instead of
    /// erroring the chat surface; a fresh launch retries from scratch.
    private var isBroken = false

    public init(databaseURL: URL, gatewayID: String) {
        self.databaseURL = databaseURL
        self.gatewayID = gatewayID
    }

    /// Startup-only cleanup, before any cache actor can own an open handle.
    public static func removeDatabaseFiles(at databaseURL: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: databaseURL)
        for suffix in ["-wal", "-shm", "-journal"] {
            try? fm.removeItem(at: URL(fileURLWithPath: databaseURL.path + suffix))
        }
    }

    // MARK: - OpenClawChatTranscriptCache

    public func loadSessions() async -> [OpenClawChatSessionEntry] {
        guard !self.isRetired else { return [] }
        guard let db = await self.handle() else { return [] }
        guard let payload = self.selectPayload(
            db,
            sql: "SELECT payload FROM cached_sessions WHERE gateway_id = ?1",
            bindings: [self.gatewayID])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatSessionEntry].self,
            from: Data(payload.utf8))
        else {
            // Decode mismatch means a stale/foreign shape: drop the row silently.
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return []
        }
        return decoded
    }

    public func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        guard !self.isRetired else { return [] }
        guard let db = await self.handle() else { return [] }
        guard let payload = self.selectPayload(
            db,
            sql: "SELECT payload FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
            bindings: [self.gatewayID, sessionKey])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatMessage].self,
            from: Data(payload.utf8))
        else {
            self.execute(
                db,
                sql: "DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
                bindings: [self.gatewayID, sessionKey])
            return []
        }
        return decoded
    }

    public func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        guard !self.isRetired else { return }
        guard let db = await self.handle() else { return }
        let bounded = Self.boundedSessions(sessions)
        guard !bounded.isEmpty else {
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_sessions(gateway_id, payload, updated_at)
            VALUES (?1, ?2, ?3)
            """,
            bindings: [self.gatewayID, payload, Date().timeIntervalSince1970])
    }

    public func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async {
        guard !self.isRetired else { return }
        guard let db = await self.handle() else { return }
        let bounded = Self.cacheableMessages(messages)
        guard !bounded.isEmpty else {
            // An emptied live transcript must also empty the cache, or the next
            // cold open would ghost-paint messages the gateway no longer has.
            self.execute(
                db,
                sql: "DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
                bindings: [self.gatewayID, sessionKey])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_transcripts(gateway_id, session_key, payload, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            """,
            bindings: [self.gatewayID, sessionKey, payload, Date().timeIntervalSince1970])
        // rowid tie-breaks equal timestamps: INSERT OR REPLACE mints a fresh
        // rowid, so the most recently written transcript always survives.
        self.execute(
            db,
            sql: """
            DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key NOT IN (
                SELECT session_key FROM cached_transcripts WHERE gateway_id = ?1
                ORDER BY updated_at DESC, rowid DESC LIMIT \(Self.maxCachedTranscripts)
            )
            """,
            bindings: [self.gatewayID])
    }

    public func retire() async {
        // A queued write then either finishes before retirement or becomes a
        // no-op. Closing the handle lets the owner delete the whole cache file.
        self.isRetired = true
        self.db = nil
    }

    // MARK: - Cached shapes

    /// Text rows only in v1: strip attachment/binary payloads and tool
    /// arguments so the cache never persists base64 blobs or large payloads.
    static func cacheableMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        messages.suffix(self.maxCachedMessagesPerSession).map { message in
            OpenClawChatMessage(
                id: message.id,
                role: message.role,
                content: message.content.map { item in
                    OpenClawChatMessageContent(
                        type: item.type,
                        text: item.text,
                        thinking: item.thinking,
                        thinkingSignature: nil,
                        mimeType: item.mimeType,
                        fileName: item.fileName,
                        content: nil,
                        id: item.id,
                        name: item.name,
                        arguments: nil)
                },
                timestamp: message.timestamp,
                idempotencyKey: message.idempotencyKey,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason,
                errorMessage: message.errorMessage)
        }
    }

    static func boundedSessions(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        guard sessions.count > self.maxCachedSessions else { return sessions }
        return Array(
            sessions
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
                .prefix(self.maxCachedSessions))
    }

    private static func encodeJSON(_ value: some Encodable) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    // MARK: - Connection lifecycle

    private func handle() async -> OpaquePointer? {
        guard !self.isRetired else { return nil }
        if let db { return db.raw }
        if self.isBroken { return nil }
        #if os(iOS)
        // Complete protection intentionally makes the cache unavailable while
        // locked. Treat that as a temporary miss, never as corruption.
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        if let opened = self.openConnection() {
            self.db = Connection(raw: opened)
            return opened
        }
        #if os(iOS)
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        // Cache is disposable: on any open/schema failure drop the file
        // (and SQLite sidecars) and rebuild once, silently.
        self.removeDatabaseFiles()
        if let reopened = self.openConnection() {
            self.db = Connection(raw: reopened)
            return reopened
        }
        cacheLogger.error("chat transcript cache unavailable; continuing without offline cache")
        self.isBroken = true
        return nil
    }

    #if os(iOS)
    private func isProtectedDataAvailable() async -> Bool {
        await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
    }
    #endif

    private func openConnection() -> OpaquePointer? {
        let fm = FileManager.default
        try? fm.createDirectory(
            at: self.databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        var opened: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        // Apply Complete protection through the SQLite VFS so auxiliary files
        // receive the same class as the main transcript database.
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
        #endif
        guard sqlite3_open_v2(self.databaseURL.path, &opened, flags, nil) == SQLITE_OK, let opened else {
            sqlite3_close_v2(opened)
            return nil
        }
        guard let version = self.readUserVersion(opened) else {
            sqlite3_close_v2(opened)
            return nil
        }
        if version == 0 {
            guard self.createSchema(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version != Self.schemaVersion {
            // Unknown schema: no migrations by design, force drop-and-rebuild.
            sqlite3_close_v2(opened)
            return nil
        }
        #if os(iOS)
        // Upgrade a database created by an older build to the stricter class.
        try? fm.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: self.databaseURL.path)
        #endif
        return opened
    }

    private func readUserVersion(_ db: OpaquePointer) -> Int32? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &statement, nil) == SQLITE_OK else {
            return nil
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return sqlite3_column_int(statement, 0)
    }

    private func createSchema(_ db: OpaquePointer) -> Bool {
        let statements = [
            """
            CREATE TABLE IF NOT EXISTS cached_sessions(
                gateway_id TEXT NOT NULL PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS cached_transcripts(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(gateway_id, session_key)
            )
            """,
            "PRAGMA user_version = \(Self.schemaVersion)",
        ]
        for sql in statements {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { return false }
        }
        return true
    }

    // MARK: - Statement helpers

    @discardableResult
    private func execute(_ db: OpaquePointer, sql: String, bindings: [Any]) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            cacheLogger.error("cache statement prepare failed")
            return false
        }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return false }
        return sqlite3_step(statement) == SQLITE_DONE
    }

    private func selectPayload(_ db: OpaquePointer, sql: String, bindings: [Any]) -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return nil }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        guard let text = sqlite3_column_text(statement, 0) else { return nil }
        return String(cString: text)
    }

    private func bind(_ statement: OpaquePointer?, bindings: [Any]) -> Bool {
        // SQLITE_TRANSIENT: sqlite copies the buffer before the Swift string dies.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in bindings.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32 = switch value {
            case let text as String:
                sqlite3_bind_text(statement, index, text, -1, transient)
            case let real as Double:
                sqlite3_bind_double(statement, index, real)
            default:
                SQLITE_MISUSE
            }
            guard result == SQLITE_OK else { return false }
        }
        return true
    }

    private func removeDatabaseFiles() {
        self.db = nil
        Self.removeDatabaseFiles(at: self.databaseURL)
    }
}
