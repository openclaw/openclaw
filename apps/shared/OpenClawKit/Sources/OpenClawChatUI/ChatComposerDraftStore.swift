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

    /// Moved or restored text goes below what the composer already holds.
    static func appending(_ text: String, to draft: String) -> String {
        text.isEmpty ? draft : draft.isEmpty ? text : draft + "\n\n" + text
    }

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

/// What moving an outbox row into a draft did.
enum OpenClawChatOutboxMoveResult: Equatable, Sendable {
    /// The row left the outbox; `attachments` are the rows appended to the
    /// draft, in the command's order.
    case moved(attachments: [OpenClawChatComposerDraft.Attachment])
    /// Canonical history proves delivery; the draft is untouched.
    case confirmed
    /// Claimed, possibly accepted, already removed, or no longer the proven failure.
    case missing
    /// The draft would pass its attachment budget; the row stays.
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
                let draftBytes = try Self.composerDraftAttachmentBytes(db, gatewayID: gatewayID, key: key)
                guard draftBytes <= Self.maxComposerDraftAttachmentBytes - bytes else { return .draftFull }
                try Self.evictComposerDraftAttachments(db, gatewayID: gatewayID, keeping: key, incomingBytes: bytes)
                try db.execute(
                    sql: """
                    INSERT INTO composer_drafts(gateway_id, draft_key, text, revision, updated_at)
                    VALUES (?, ?, '', ?, ?)
                    ON CONFLICT(gateway_id, draft_key) DO UPDATE SET updated_at = excluded.updated_at
                    """,
                    arguments: [gatewayID, key, Int64(bitPattern: revision), Date().timeIntervalSince1970])
                let inserted = try Self.appendComposerDraftAttachments([attachment], db, gatewayID: gatewayID, key: key)
                return .inserted(position: inserted[0].position)
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

    /// Edit and auto-restore: deletes a queued or failed command and appends
    /// its text and attachments to a draft in one write, under cancel's
    /// canonical-proof decision, so a delivered turn is never copied back.
    /// Rows whose delivery is in doubt (claimed, unconfirmed, or parked by a
    /// branch change, which may follow an accepted attempt) stay. `restoring`
    /// pins the failure the caller found absent from history; an expired row
    /// qualifies only if it never left the device, and a restore never evicts
    /// other drafts' attachments. Row text never changes, so Edit needs no
    /// attempt check.
    func cancelCommand(
        id: String,
        moveToDraftKey key: String,
        revision: UInt64,
        restoring failure: OpenClawChatOutboxRetryExpectation? = nil) async -> OpenClawChatOutboxMoveResult
    {
        guard !self.isRetired else { return .unavailable }
        let gatewayID = self.gatewayID
        do {
            let (result, isProven) = try await self.decideAgainstCanonicalProof(commandID: id) { db, isProven
                -> OpenClawChatOutboxMoveResult in
                if isProven {
                    // Same as cancel: the delivered row leaves as confirmed.
                    return try Self.deleteRemovableCommand(db, gatewayID: gatewayID, id: id) ? .confirmed : .missing
                }
                guard let text = try String.fetchOne(
                    db,
                    sql: """
                    SELECT text FROM outbox_commands
                    WHERE gateway_id = ? AND client_uuid = ? AND status IN ('queued', 'failed')
                      AND last_error <> ? AND instr(last_error, char(10) || '# branch-park:') = 0
                      AND (? IS NULL OR (
                        status = 'failed' AND attempt_version = ? AND retry_count = ? AND last_error = ?
                        AND (last_error <> ? OR (attempt_version = 1 AND had_unacknowledged_send = 0))))
                    """,
                    arguments: [
                        gatewayID,
                        id,
                        Self.outboxUnconfirmedError,
                        failure?.attemptVersion,
                        failure?.attemptVersion,
                        failure?.retryCount,
                        failure.map { $0.lastError ?? "" },
                        Self.outboxExpiredError,
                    ])
                else { return .missing }
                let attachments = try Row.fetchAll(
                    db,
                    sql: """
                    SELECT type, mime_type, file_name, payload, duration_seconds FROM outbox_attachments
                    WHERE gateway_id = ? AND command_id = ? ORDER BY position
                    """,
                    arguments: [gatewayID, id]).map { row in
                    OpenClawChatOutboxAttachment(
                        type: row["type"],
                        mimeType: row["mime_type"],
                        fileName: row["file_name"],
                        data: row["payload"],
                        durationSeconds: row["duration_seconds"])
                }
                let bytes = attachments.reduce(0) { $0 + $1.data.count }
                if bytes > 0 {
                    let draftBytes = try Self.composerDraftAttachmentBytes(db, gatewayID: gatewayID, key: key)
                    guard draftBytes <= Self.maxComposerDraftAttachmentBytes - bytes else { return .draftFull }
                    if failure == nil {
                        try Self.evictComposerDraftAttachments(
                            db, gatewayID: gatewayID, keeping: key, incomingBytes: bytes)
                    } else {
                        let storedBytes = try Int.fetchOne(
                            db,
                            sql: """
                            SELECT COALESCE(SUM(length(payload)), 0) FROM composer_draft_attachments
                            WHERE gateway_id = ?
                            """,
                            arguments: [gatewayID]) ?? 0
                        guard storedBytes <= Self.maxComposerDraftsAttachmentBytes - bytes else { return .draftFull }
                    }
                }
                let stored = try String.fetchOne(
                    db,
                    sql: "SELECT text FROM composer_drafts WHERE gateway_id = ? AND draft_key = ?",
                    arguments: [gatewayID, key]) ?? ""
                let merged = OpenClawChatComposerDraft.appending(text, to: stored)
                try db.execute(
                    sql: """
                    INSERT INTO composer_drafts(gateway_id, draft_key, text, revision, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(gateway_id, draft_key) DO UPDATE SET
                        text = excluded.text,
                        revision = MAX(revision, excluded.revision),
                        updated_at = excluded.updated_at
                    """,
                    arguments: [gatewayID, key, merged, Int64(bitPattern: revision), Date().timeIntervalSince1970])
                let moved = try Self.appendComposerDraftAttachments(attachments, db, gatewayID: gatewayID, key: key)
                try db.execute(
                    sql: "DELETE FROM outbox_commands WHERE gateway_id = ? AND client_uuid = ?",
                    arguments: [gatewayID, id])
                try Self.deleteEmptyComposerDraft(db, gatewayID: gatewayID, key: key)
                return .moved(attachments: moved)
            }
            if isProven {
                if result == .confirmed {
                    self.outboxChangeHub.yield(.confirmed(gatewayID: gatewayID, id: id))
                }
                return .confirmed
            }
            if case .moved = result {
                // Other view models drop the bubble; the initiating one owns its result.
                self.outboxChangeHub.yield(.canceled(gatewayID: gatewayID, id: id))
            }
            return result
        } catch {
            draftLogger.error("outbox move to draft failed: \(error.localizedDescription, privacy: .public)")
            return .unavailable
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

    private nonisolated static func composerDraftAttachmentBytes(
        _ db: Database,
        gatewayID: String,
        key: String) throws -> Int
    {
        try Int.fetchOne(
            db,
            sql: """
            SELECT COALESCE(SUM(length(payload)), 0) FROM composer_draft_attachments
            WHERE gateway_id = ? AND draft_key = ?
            """,
            arguments: [gatewayID, key]) ?? 0
    }

    /// Appends after the draft's last position, keeping the given order.
    private nonisolated static func appendComposerDraftAttachments(
        _ attachments: [OpenClawChatOutboxAttachment],
        _ db: Database,
        gatewayID: String,
        key: String) throws -> [OpenClawChatComposerDraft.Attachment]
    {
        let firstPosition = try Int.fetchOne(
            db,
            sql: """
            SELECT COALESCE(MAX(position) + 1, 0) FROM composer_draft_attachments
            WHERE gateway_id = ? AND draft_key = ?
            """,
            arguments: [gatewayID, key]) ?? 0
        return try attachments.enumerated().map { offset, attachment in
            let position = firstPosition + offset
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
            return OpenClawChatComposerDraft.Attachment(position: position, attachment: attachment)
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
