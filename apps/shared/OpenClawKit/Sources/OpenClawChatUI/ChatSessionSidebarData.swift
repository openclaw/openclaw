import Foundation
import Observation
import OpenClawProtocol

/// The macOS window owns one roster. Views retain query membership, never mutable row copies.
@MainActor @Observable
public final class OpenClawChatSessionSidebarData {
    struct Read {
        let scope: Int
        let revision: Int
    }

    enum Field: String, CaseIterable { case label, pinned, archived, unread, category, color }
    private struct Pending {
        let target: OpenClawChatSessionEntry
        let field: Field
        let update: (inout OpenClawChatSessionEntry) -> Void
    }

    @ObservationIgnored private var entries: [String: OpenClawChatSessionEntry] = [:]
    @ObservationIgnored private var rosters: [String: [String]] = [:]
    private var rosterRevisions: [String: Int] = [:]
    private var revisions: [String: Int] = [:]
    private var fieldDates: [String: [Field: Double]] = [:]
    private var receipts: [String: [Field: (ack: OpenClawChatSessionPatchReceipt, cutoff: Int, order: Int)]] = [:]
    @ObservationIgnored private var pending: [Int: Pending] = [:]
    @ObservationIgnored private var latest: [String: Int] = [:]
    private var revision = 0
    private(set) var scopeRevision = 0
    var onChange: (() -> Void)?
    var queryState: ChatSidebarQueryState?
    @ObservationIgnored var queryTask: Task<Void, Never>?

    enum Projection: Hashable { case conversation(String), members([String]), swarm, sidebar, sidebarTree }
    private(set) var projectionRevision = 0
    @ObservationIgnored private var projections: [Projection: [OpenClawChatSessionEntry]] = [:]
    @ObservationIgnored var onProjectionComputed: ((Projection) -> Void)?

    public init() {}

    isolated deinit { self.queryTask?.cancel() }

    func invalidateQueryProjection() {
        self.projections[.sidebar] = nil
        self.projections[.sidebarTree] = nil
    }

    static func identity(_ row: OpenClawChatSessionEntry) -> String {
        "\(OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId ?? "")\u{0}\(row.key)"
    }

    func row(key: String, agentID: String?) -> OpenClawChatSessionEntry? {
        let id = "\(OpenClawChatSessionKey.agentID(from: key) ?? agentID ?? "")\u{0}\(key)"
        return self.project([id]).first
    }

    func project(_ ids: [String]) -> [OpenClawChatSessionEntry] {
        self.cachedProjection(.members(ids)) {
            ids.compactMap { self.entries[$0].map(self.project) }
        }
    }

    private func project(_ entry: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry {
        var row = entry
        for (id, intent) in self.pending.sorted(by: { $0.key < $1.key }) where
            self.latest[Self.identity(intent.target) + "\u{0}" + intent.field.rawValue] == id &&
            Self.identity(intent.target) == Self.identity(row) && intent.target.sessionId == row.sessionId
        {
            var proposed = row
            intent.update(&proposed)
            Self.copy(intent.field, from: proposed, to: &row)
        }
        return row
    }

    func conversationRows(agentID: String?) -> [OpenClawChatSessionEntry] {
        self.cachedProjection(.conversation(agentID ?? "")) {
            OpenClawChatSessionListOrganizer
                .organize(self.project(self.rosters[agentID ?? ""] ?? []).filter { !$0.isArchived })
        }
    }

    func cachedProjection(
        _ key: Projection, build: () -> [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry]
    {
        // Cache hits must still subscribe to the owner boundary, including empty rosters.
        _ = self.projectionRevision
        if let rows = self.projections[key] { return rows }
        self.onProjectionComputed?(key)
        let rows = build()
        self.projections[key] = rows
        return rows
    }

    private func didChange() {
        self.projections.removeAll(keepingCapacity: true)
        self.projectionRevision += 1
        self.onChange?()
    }

    func beginRead() -> Read {
        self.revision += 1
        return Read(scope: self.scopeRevision, revision: self.revision)
    }

    /// All list ingress uses request order, local-write order, then same-incarnation observer order.
    @discardableResult
    func receive(
        _ rows: [OpenClawChatSessionEntry],
        read: Read,
        replacingAgent agentID: String? = nil,
        enriched: Bool = false) -> [String]
    {
        guard read.scope == self.scopeRevision else { return [] }
        if let agentID, read.revision < self.rosterRevisions[agentID, default: 0] { return [] }
        var entries = self.entries
        for incoming in rows {
            let id = Self.identity(incoming)
            guard read.revision >= self.revisions[id, default: 0] else { continue }
            if let held = entries[id], held.sessionId == incoming.sessionId,
               let offeredDate = incoming.updatedAt, let heldDate = held.updatedAt, offeredDate < heldDate { continue }
            var row = incoming
            if !enriched, let held = entries[id], held.sessionId == row.sessionId, row.sessionId != nil {
                // Existing metadata/palette requests omit enrichment; absence is not a clearing receipt.
                row.derivedTitle = row.derivedTitle ?? held.derivedTitle
                row.lastMessagePreview = row.lastMessagePreview ?? held.lastMessagePreview
            }
            if let held = entries[id], held.sessionId == row.sessionId, row.sessionId != nil,
               ChatSessionSidebarModel.isRunning(row), let digest = held.observerDigest,
               let runID = digest.runId, row.activeRunIds?.contains(runID) == true,
               row.observerDigest.map({ ChatSessionSidebarModel.isNewer(digest, than: $0) }) ?? true
            {
                // ui/src/lib/observer-digest.ts:60 orders copies by observer revision, then updatedAt.
                row.observerDigest = digest
            }
            let receipts = (self.receipts[id] ?? [:]).sorted {
                ($0.value.ack.entry.updatedAt ?? 0, $0.value.order) < (
                    $1.value.ack.entry.updatedAt ?? 0,
                    $1.value.order)
            }
            for (field, receipt) in receipts where receipt.ack.matches(row) {
                if (row.updatedAt ?? 0) < (receipt.ack.entry.updatedAt ?? 0) || read.revision <= receipt.cutoff {
                    row = receipt.ack.applying(field: field, to: row)
                }
            }
            self.recordFieldChanges(row, previous: entries[id], at: row.updatedAt ?? 0)
            entries[id] = row
            self.revisions[id] = read.revision
        }
        let ids = rows.map(Self.identity)
        if let agentID {
            self.rosters[agentID] = ids
            self.rosterRevisions[agentID] = read.revision
        }
        self.entries = entries
        self.didChange()
        return ids
    }

    func replaceConversationRows(_ rows: [OpenClawChatSessionEntry], agentID: String?) {
        let read = self.beginRead()
        var entries = self.entries
        let ids = rows.filter {
            ChatSessionSidebarModel.isSessionInActiveAgentScope(
                key: $0.key,
                agentID: $0.agentId,
                activeAgentID: agentID)
        }.map(Self.identity)
        let hidden = (self.rosters[agentID ?? ""] ?? [])
            .filter { self.entries[$0].map(self.project)?.isArchived == true }
        for old in self.conversationRows(agentID: agentID) where !ids.contains(Self.identity(old)) {
            entries.removeValue(forKey: Self.identity(old))
            self.revisions[Self.identity(old)] = read.revision
        }
        for incoming in rows {
            let id = Self.identity(incoming)
            var row = incoming
            if let canonical = entries[id] {
                let visible = self.project(canonical)
                for intent in self.pending.values where Self.identity(intent.target) == id &&
                    intent.target.sessionId == row.sessionId
                {
                    // A writer changing run/settings facts must not commit another field's optimistic overlay.
                    if Self.same(intent.field, incoming, visible) { Self.copy(intent.field, from: canonical, to: &row) }
                }
            }
            if entries[id] != row {
                self.recordFieldChanges(row, previous: entries[id], at: row.updatedAt ?? 0)
                entries[id] = row
                self.revisions[id] = read.revision
            }
        }
        self.entries = entries
        let nextIDs = ids + hidden.filter { !ids.contains($0) }
        // Field writes fence row facts without superseding an in-flight membership read.
        if Set(self.rosters[agentID ?? ""] ?? []) != Set(nextIDs) {
            self.rosterRevisions[agentID ?? ""] = read.revision
        }
        self.rosters[agentID ?? ""] = nextIDs
        self.didChange()
    }

    func settleSettingsWrite(target: OpenClawChatSessionEntry?, scope: Int?) {
        guard scope == self.scopeRevision, let target,
              let current = self.entries[Self.identity(target)], current.sessionId == target.sessionId else { return }
        // A same-value ACK still supersedes reads issued while the settings intent was pending.
        self.revision += 1
        self.revisions[Self.identity(target)] = self.revision
    }

    func beginMutation(
        target: OpenClawChatSessionEntry,
        field: Field,
        update: @escaping (inout OpenClawChatSessionEntry) -> Void) -> Int?
    {
        guard let current = self.entries[Self.identity(target)],
              current.sessionId == target.sessionId else { return nil }
        self.revision += 1
        self.pending[self.revision] = Pending(target: target, field: field, update: update)
        self.latest[Self.identity(target) + "\u{0}" + field.rawValue] = self.revision
        self.didChange()
        return self.revision
    }

    func beginBatchMutation(target: OpenClawChatSessionEntry, action: ChatSessionBatchAction) -> Int? {
        guard action != .delete else { return nil }
        return self.beginMutation(target: target, field: action == .archive ? .archived : .pinned) {
            if action == .archive {
                $0.archived = true
            } else {
                $0.pinned = action == .pin
            }
        }
    }

    func finishMutation(_ token: Int?, receipt: OpenClawChatSessionPatchReceipt?) {
        guard let token, let intent = self.pending.removeValue(forKey: token) else { return }
        if let receipt {
            self.confirmFields(receipt, target: intent.target, field: intent.field, order: token)
        } else {
            self.didChange()
        }
    }

    func confirmFields(
        _ receipt: OpenClawChatSessionPatchReceipt,
        target: OpenClawChatSessionEntry,
        field: Field,
        order: Int? = nil)
    {
        defer { self.didChange() }
        let id = Self.identity(target)
        guard receipt.matches(target), let current = self.entries[id], receipt.matches(current),
              (self.receipts[id]?[field]?.order ?? 0) <= (order ?? self.revision),
              self.fieldDates[id]?[field] ?? 0 <= receipt.entry.updatedAt ?? 0 else { return }
        // ui/src/lib/sessions/session-mutations.ts:328 retains acknowledged fields across older reads.
        self.receipts[id, default: [:]][field] = (receipt, self.revision, order ?? self.revision)
        let accepted = receipt.applying(field: field, to: current)
        self.recordFieldChanges(accepted, previous: current, at: receipt.entry.updatedAt ?? 0)
        self.entries[id] = accepted
    }

    func remove(_ target: OpenClawChatSessionEntry) {
        let id = Self.identity(target)
        guard self.entries[id]?.sessionId == target.sessionId else { return }
        self.revision += 1
        self.revisions[id] = self.revision
        self.entries.removeValue(forKey: id)
        self.didChange()
    }

    func invalidate(clear: Bool = false) {
        self.invalidateQuery(clear: clear)
        self.scopeRevision += 1
        self.pending = [:]
        self.latest = [:]
        self.receipts = [:]
        if clear {
            self.entries = [:]
            self.rosters = [:]
        }
        self.didChange()
    }

    func applyObserver(_ digest: SessionObserverDigest) {
        self.entries = self.entries.mapValues { row in
            guard digest.sessionid == nil || digest.sessionid == row.sessionId else { return row }
            return ChatSessionSidebarModel.applying(observerDigest: digest, to: [row], activeAgentId: row.agentId)
                .first ?? row
        }
        self.didChange()
    }

    private func recordFieldChanges(
        _ row: OpenClawChatSessionEntry,
        previous: OpenClawChatSessionEntry?,
        at date: Double)
    {
        let id = Self.identity(row)
        if row.sessionId != previous?.sessionId { self.fieldDates[id] = [:] }
        // A lifecycle timestamp does not acknowledge a label/pin edit. Track only fields that actually changed.
        for field in Field.allCases where previous.map({ !Self.same(field, $0, row) }) ?? true {
            self.fieldDates[id, default: [:]][field] = max(self.fieldDates[id]?[field] ?? 0, date)
        }
    }

    private static func same(_ field: Field, _ lhs: OpenClawChatSessionEntry, _ rhs: OpenClawChatSessionEntry) -> Bool {
        var left = OpenClawChatSessionEntry(key: "")
        var right = left
        self.copy(field, from: lhs, to: &left)
        self.copy(field, from: rhs, to: &right)
        return left == right
    }

    static func copy(_ field: Field, from source: OpenClawChatSessionEntry, to row: inout OpenClawChatSessionEntry) {
        switch field {
        case .label:
            row.label = source.label
        case .pinned:
            row.pinned = source.pinned
            row.pinnedAt = source.pinnedAt
        case .archived:
            row.archived = source.archived
            row.archivedAt = source.archivedAt
            row.archivedBy = source.archivedBy
            row.archiveReason = source.archiveReason
        case .unread:
            row.unread = source.unread
            row.lastReadAt = source.lastReadAt
            row.markedUnreadAt = source.markedUnreadAt
            row.agentStatus = source.agentStatus
        case .category: row.category = source.category
        case .color: row.color = source.color
        }
    }
}
