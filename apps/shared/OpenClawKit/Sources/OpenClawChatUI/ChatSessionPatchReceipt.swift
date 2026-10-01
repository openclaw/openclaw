public struct OpenClawChatSessionPatchReceipt: Decodable, Sendable {
    public struct Entry: Decodable, Sendable {
        let sessionId: String
        let label: String?
        let category: String?
        let color: String?
        let pinnedAt: Double?
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

    private enum CodingKeys: String, CodingKey { case key, entry }

    func matches(_ row: OpenClawChatSessionEntry) -> Bool {
        self.key == row.key && self.entry.sessionId == row.sessionId &&
            self.agentID == (OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId)
    }

    @MainActor
    func applying(
        field: OpenClawChatSessionSidebarData.Field,
        to row: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry
    {
        guard self.matches(row) else { return row }
        var row = row
        switch field {
        case .label:
            row.label = self.entry.label
        case .category: row.category = self.entry.category
        case .color: row.color = self.entry.color
        case .pinned:
            // ui/src/lib/sessions/session-patch-row-facts.ts:56 derives pin state from pinnedAt.
            row.pinned = self.entry.pinnedAt != nil
            row.pinnedAt = self.entry.pinnedAt
        case .archived:
            row.archived = self.entry.archivedAt != nil
            row.archivedAt = self.entry.archivedAt
            row.archivedBy = self.entry.archivedBy
            row.archiveReason = self.entry.archiveReason
            if row.archived == true {
                row.pinned = false
                row.pinnedAt = nil
            }
        case .unread: return self.applyingRead(to: row)
        }
        return row
    }

    func applyingRead(to row: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry {
        guard self.matches(row), (row.updatedAt ?? 0) <= (self.entry.updatedAt ?? 0) else { return row }
        var row = row
        // src/shared/session-unread.ts:3 derives unread from the acknowledged entry, not the requested value.
        let baseline = self.entry.lastReadAt ?? self.entry.createdAt
        row.unread = self.entry.markedUnreadAt != nil || baseline.map {
            max(self.entry.lastInteractionAt ?? 0, self.entry.lastActivityAt ?? 0) > $0
        } == true
        row.lastReadAt = self.entry.lastReadAt
        row.markedUnreadAt = self.entry.markedUnreadAt
        row.agentStatus = self.entry.agentStatus
        return row
    }
}
