import Foundation

/// Private outcome accompanying a successful shared archive. Bad or absent metadata cannot undo that commit.
public struct OpenClawChatArchivePinOutcome: Sendable {
    let archivePin: String?
    let archivedAt: Int?
    let undo: String?

    public init(archivePin: String?, archivedAt: Int?, undo: String? = nil) {
        self.archivePin = archivePin
        self.archivedAt = archivedAt.flatMap { $0 >= 0 ? $0 : nil }
        self.undo = archivePin == "removed" && self.archivedAt != nil && undo?.isEmpty == false ? undo : nil
    }

    public var warning: String? {
        switch self.archivePin {
        case "conflict": String(localized: "Thread archived. Your sidebar changed; the pin was not removed.")
        case "removed" where self.archivedAt != nil, "unchanged" where self.archivedAt != nil: nil
        default: String(localized: "Thread archived. Could not confirm the personal pin update.")
        }
    }

    var undoWarning: String? {
        if self.archivedAt == nil {
            return String(localized: "Thread archived. Archive Undo is unavailable; refresh to check your sidebar.")
        }
        if self.archivePin == "removed", self.undo == nil {
            return String(localized: "Thread archived and pin removed. Undo can restore only the thread.")
        }
        return self.warning
    }
}

public struct OpenClawChatSessionPatchReceipt: Decodable, Sendable {
    public struct Entry: Decodable, Sendable {
        let sessionId: String
        let label: String?
        let category: String?
        let color: String?
        let pinned: Bool?
        let pinnedAt: Double?
        let snoozedUntil: Double?
        let snoozedAt: Double?
        let archivedAt: Double?
        let archivedBy: OpenClawChatSessionEntry.CreatedActor?
        let archiveReason: String?
        let updatedAt: Double?
        let createdAt: Double?
        let lastReadAt: Double?
        let markedUnreadAt: Double?
        let lastInteractionAt: Double?
        let lastActivityAt: Double?
        let agentStatus: OpenClawChatSessionAgentStatus?
    }

    let key: String
    let entry: Entry
    var agentID: String?

    public let archivePin: String?
    public let archivedAt: Int?
    public let archivePinUndo: String?

    private enum CodingKeys: String, CodingKey { case key, entry, archivePin, archivedAt, archivePinUndo }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        self.key = try fields.decode(String.self, forKey: .key)
        self.entry = try fields.decode(Entry.self, forKey: .entry)
        // Malformed optional personal metadata is not a shared lifecycle failure.
        self.archivePin = try? fields.decode(String.self, forKey: .archivePin)
        self.archivedAt = try? fields.decode(Int.self, forKey: .archivedAt)
        self.archivePinUndo = try? fields.decode(String.self, forKey: .archivePinUndo)
    }

    func matches(_ row: OpenClawChatSessionEntry) -> Bool {
        self.key == row.key && self.entry.sessionId == row.sessionId &&
            self.agentID == (OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId)
    }

    @MainActor
    func applying(
        field: OpenClawChatSessionSidebarData.Field,
        to row: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry
    {
        var row = row
        switch field {
        case .label:
            row.label = self.entry.label
        case .category: row.category = self.entry.category
        case .color: row.color = self.entry.color
        case .pinned:
            // Older Gateways returned a timestamp instead of a personal pin flag.
            row.pinned = self.entry.pinned ?? (self.entry.pinnedAt != nil)
            row.pinnedAt = self.entry.pinnedAt
        case .archived:
            row.archived = self.entry.archivedAt != nil
            row.archivedAt = self.entry.archivedAt
            row.archivedBy = self.entry.archivedBy
            row.archiveReason = self.entry.archiveReason
        case .snoozed:
            row.snoozedUntil = self.entry.snoozedUntil
            row.snoozedAt = self.entry.snoozedAt
        case .unread:
            guard (row.updatedAt ?? 0) <= (self.entry.updatedAt ?? 0) else { return row }
            // src/shared/session-unread.ts:3 derives unread from the acknowledged entry, not the requested value.
            let baseline = self.entry.lastReadAt ?? self.entry.createdAt
            row.unread = self.entry.markedUnreadAt != nil || baseline.map {
                max(self.entry.lastInteractionAt ?? 0, self.entry.lastActivityAt ?? 0) > $0
            } == true
            row.lastReadAt = self.entry.lastReadAt
            row.markedUnreadAt = self.entry.markedUnreadAt
            row.agentStatus = self.entry.agentStatus
        }
        return row
    }
}
