import Foundation
import GRDB
import OSLog

private let draftLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatComposerDrafts")

/// One session's durable composer draft. `revision` is the composer edit
/// counter at the last text save.
struct OpenClawChatComposerDraft: Equatable, Sendable {
    struct Attachment: Equatable, Sendable {
        let position: Int
        let attachment: OpenClawChatOutboxAttachment
    }

    static let empty = Self(text: "", revision: 0, attachments: [])

    let text: String
    let revision: UInt64
    let attachments: [Attachment]
}

enum OpenClawChatComposerDraftAttachmentResult: Equatable, Sendable {
    case inserted(position: Int)
    /// The draft would exceed the per-draft attachment budget.
    case draftFull
    case unavailable
}

/// What a send took from its draft: text saved at or before `revision` and
/// the stored attachments it carried.
struct OpenClawChatComposerDraftConsumption: Equatable, Sendable {
    let draftKey: String
    let revision: UInt64
    let attachmentPositions: [Int]
}

/// One serial chain for every view model's draft writes, so a replacement
/// model's load reads after the writes its predecessor started.
final class ComposerDraftWriteChain: @unchecked Sendable {
    private let lock = NSLock()
    private var last: Task<Void, Never>?

    var tail: Task<Void, Never>? {
        self.lock.withLock { self.last }
    }

    func append(_ write: @escaping @MainActor @Sendable () async -> Void) {
        self.lock.withLock {
            let previous = self.last
            self.last = Task { @MainActor in
                await previous?.value
                await write()
            }
        }
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    // MARK: - Client-state composer drafts

    /// A draft holds at most what one queued command may carry.
    static let maxComposerDraftAttachmentBytes = maxAttachmentBytesPerCommand
    static let maxComposerDraftsAttachmentBytes = 50_000_000

    /// Nil means storage was unreadable, not that the draft is empty.
    func loadComposerDraft(key: String) async -> OpenClawChatComposerDraft? {
        guard !self.isRetired else { return nil }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.read { db in
                guard let row = try Row.fetchOne(
                    db,
                    sql: "SELECT text, revision FROM composer_drafts WHERE gateway_id = ? AND draft_key = ?",
                    arguments: [gatewayID, key])
                else { return .empty }
                let attachments = try Row.fetchAll(
                    db,
                    sql: """
                    SELECT position, type, mime_type, file_name, payload, duration_seconds
                    FROM composer_draft_attachments
                    WHERE gateway_id = ? AND draft_key = ? ORDER BY position
                    """,
                    arguments: [gatewayID, key]).map { attachment in
                    OpenClawChatComposerDraft.Attachment(
                        position: attachment["position"],
                        attachment: OpenClawChatOutboxAttachment(
                            type: attachment["type"],
                            mimeType: attachment["mime_type"],
                            fileName: attachment["file_name"],
                            data: attachment["payload"],
                            durationSeconds: attachment["duration_seconds"]))
                }
                let revision: Int64 = row["revision"]
                return OpenClawChatComposerDraft(
                    text: row["text"],
                    revision: UInt64(bitPattern: revision),
                    attachments: attachments)
            }
        } catch {
            draftLogger.error("composer draft read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Touches `composer_drafts` only; attachment blobs are never rewritten.
    /// Two composers on one key (macOS windows) are last writer wins.
    /// False means the row was not written, so the caller still owns the text.
    @discardableResult
    func saveComposerDraftText(key: String, text: String, revision: UInt64) async -> Bool {
        await self.writeComposerDraft("text save") { db, gatewayID in
            try db.execute(
                sql: """
                INSERT INTO composer_drafts(gateway_id, draft_key, text, revision, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(gateway_id, draft_key) DO UPDATE SET
                    text = excluded.text,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                arguments: [gatewayID, key, text, Int64(bitPattern: revision), Date().timeIntervalSince1970])
            try Self.deleteEmptyComposerDraft(db, gatewayID: gatewayID, key: key)
        }
    }

    /// Frees the gateway budget by dropping attachments, never text, of the
    /// least recently updated other drafts. The edited draft is never evicted.
    func insertComposerDraftAttachment(
        key: String,
        attachment: OpenClawChatOutboxAttachment,
        revision: UInt64) async -> OpenClawChatComposerDraftAttachmentResult
    {
        guard !self.isRetired else { return .unavailable }
        let bytes = attachment.data.count
        guard bytes <= Self.maxComposerDraftAttachmentBytes else { return .draftFull }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                let draftBytes = try Int.fetchOne(
                    db,
                    sql: """
                    SELECT COALESCE(SUM(length(payload)), 0) FROM composer_draft_attachments
                    WHERE gateway_id = ? AND draft_key = ?
                    """,
                    arguments: [gatewayID, key]) ?? 0
                guard draftBytes <= Self.maxComposerDraftAttachmentBytes - bytes else { return .draftFull }
                try Self.evictComposerDraftAttachments(db, gatewayID: gatewayID, keeping: key, incomingBytes: bytes)
                try db.execute(
                    sql: """
                    INSERT INTO composer_drafts(gateway_id, draft_key, text, revision, updated_at)
                    VALUES (?, ?, '', ?, ?)
                    ON CONFLICT(gateway_id, draft_key) DO UPDATE SET updated_at = excluded.updated_at
                    """,
                    arguments: [gatewayID, key, Int64(bitPattern: revision), Date().timeIntervalSince1970])
                let position = try Int.fetchOne(
                    db,
                    sql: """
                    SELECT COALESCE(MAX(position) + 1, 0) FROM composer_draft_attachments
                    WHERE gateway_id = ? AND draft_key = ?
                    """,
                    arguments: [gatewayID, key]) ?? 0
                try db.execute(
                    sql: """
                    INSERT INTO composer_draft_attachments(
                        gateway_id, draft_key, position, type, mime_type, file_name, payload, duration_seconds
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    arguments: [
                        gatewayID,
                        key,
                        position,
                        attachment.type,
                        attachment.mimeType,
                        attachment.fileName,
                        attachment.data,
                        attachment.durationSeconds,
                    ])
                return .inserted(position: position)
            }
        } catch {
            draftLogger.error("composer draft attachment save failed: \(error.localizedDescription, privacy: .public)")
            return .unavailable
        }
    }

    func deleteComposerDraftAttachment(key: String, position: Int) async {
        await self.writeComposerDraft("attachment delete") { db, gatewayID in
            try db.execute(
                sql: """
                DELETE FROM composer_draft_attachments
                WHERE gateway_id = ? AND draft_key = ? AND position = ?
                """,
                arguments: [gatewayID, key, position])
            try db.execute(
                sql: "UPDATE composer_drafts SET updated_at = ? WHERE gateway_id = ? AND draft_key = ?",
                arguments: [Date().timeIntervalSince1970, gatewayID, key])
            try Self.deleteEmptyComposerDraft(db, gatewayID: gatewayID, key: key)
        }
    }

    /// Clears what a send took, inside the enqueue transaction. Text from a later save survives.
    nonisolated static func consumeComposerDraft(
        _ consumption: OpenClawChatComposerDraftConsumption,
        in db: Database,
        gatewayID: String) throws
    {
        for position in consumption.attachmentPositions {
            try db.execute(
                sql: """
                DELETE FROM composer_draft_attachments
                WHERE gateway_id = ? AND draft_key = ? AND position = ?
                """,
                arguments: [gatewayID, consumption.draftKey, position])
        }
        try db.execute(
            sql: """
            UPDATE composer_drafts SET text = '', updated_at = ?
            WHERE gateway_id = ? AND draft_key = ? AND revision <= ?
            """,
            arguments: [
                Date().timeIntervalSince1970,
                gatewayID,
                consumption.draftKey,
                Int64(bitPattern: consumption.revision),
            ])
        try self.deleteEmptyComposerDraft(db, gatewayID: gatewayID, key: consumption.draftKey)
    }

    @discardableResult
    private func writeComposerDraft(
        _ operation: StaticString,
        _ write: @escaping @Sendable (Database, String) throws -> Void) async -> Bool
    {
        guard !self.isRetired else { return false }
        let gatewayID = self.gatewayID
        do {
            try await self.databases.stateQueue.write { db in try write(db, gatewayID) }
            return true
        } catch {
            draftLogger.error(
                "composer draft \(operation, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private nonisolated static func evictComposerDraftAttachments(
        _ db: Database,
        gatewayID: String,
        keeping key: String,
        incomingBytes: Int) throws
    {
        var storedBytes = try Int.fetchOne(
            db,
            sql: "SELECT COALESCE(SUM(length(payload)), 0) FROM composer_draft_attachments WHERE gateway_id = ?",
            arguments: [gatewayID]) ?? 0
        guard storedBytes > self.maxComposerDraftsAttachmentBytes - incomingBytes else { return }
        // The per-draft cap is below the gateway budget, so evicting every
        // other draft always makes room for the edited one.
        let candidates = try Row.fetchAll(
            db,
            sql: """
            SELECT d.draft_key, SUM(length(a.payload)) AS bytes
            FROM composer_drafts d
            JOIN composer_draft_attachments a
                ON a.gateway_id = d.gateway_id AND a.draft_key = d.draft_key
            WHERE d.gateway_id = ? AND d.draft_key <> ?
            GROUP BY d.draft_key
            ORDER BY d.updated_at, d.draft_key
            """,
            arguments: [gatewayID, key])
        for candidate in candidates where storedBytes > self.maxComposerDraftsAttachmentBytes - incomingBytes {
            let evictedKey: String = candidate["draft_key"]
            try db.execute(
                sql: "DELETE FROM composer_draft_attachments WHERE gateway_id = ? AND draft_key = ?",
                arguments: [gatewayID, evictedKey])
            try self.deleteEmptyComposerDraft(db, gatewayID: gatewayID, key: evictedKey)
            storedBytes -= candidate["bytes"] as Int
        }
    }

    private nonisolated static func deleteEmptyComposerDraft(
        _ db: Database,
        gatewayID: String,
        key: String) throws
    {
        try db.execute(
            sql: """
            DELETE FROM composer_drafts
            WHERE gateway_id = ? AND draft_key = ? AND text = ''
                AND NOT EXISTS (
                    SELECT 1 FROM composer_draft_attachments
                    WHERE gateway_id = ? AND draft_key = ?
                )
            """,
            arguments: [gatewayID, key, gatewayID, key])
    }
}
