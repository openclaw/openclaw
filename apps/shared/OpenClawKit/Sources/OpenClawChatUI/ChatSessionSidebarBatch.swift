#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol

struct ChatSidebarSelection {
    var keys: Set<String> = []
    var active = false

    static func visibleRoots(
        in sections: [ChatSessionSidebarModel.Section],
        searching: Bool,
        isCollapsed: (String) -> Bool) -> [OpenClawChatSessionEntry]
    {
        // ui/src/components/app-sidebar-session-projection.ts:278 excludes collapsed sections from action capture.
        sections.filter { !$0.id.hasPrefix("group:") || !isCollapsed($0.title ?? "") || searching }
            .flatMap(\.nodes).map(\.session)
    }

    mutating func update(_ proposed: Set<String>, roots: Set<String>, multiple: Bool) -> String? {
        self.active = multiple
        self.keys = multiple ? proposed.intersection(roots) : []
        return multiple ? nil : proposed.first
    }
}

@MainActor @Observable
final class ChatSidebarPinProfile {
    private(set) var savedKeys: Set<String>?
    var verified: Bool {
        self.savedKeys != nil
    }

    private var readRevision = 0
    static let pinKey = "ui.railShortcuts"
    private struct PinSnapshot: Decodable {
        let status: String
        let entries: [String: [AnyCodable]]?
    }

    func read(
        _ connection: OpenClawSessionMenuConnection,
        forDisplay: Bool = false) async throws -> [AnyCodable]
    {
        self.readRevision += 1
        let revision = self.readRevision
        // A lost read keeps the last verified profile; only a definitive reply changes it.
        let reply: PinSnapshot = try await connection.read("users.prefs.get", ["keys": .init([Self.pinKey])])
        var savedKeys: Set<String>?
        defer { if self.readRevision == revision { self.savedKeys = savedKeys } }
        if reply.status == "no_durable_identity" {
            guard forDisplay else { throw URLError(.userAuthenticationRequired) }
            return []
        }
        guard reply.status == "ok", let entries = reply.entries else { throw CocoaError(.coderReadCorrupt) }
        let layout = entries[Self.pinKey] ?? ["route:cron", "route:plugins", "route:usage"].map(AnyCodable.init)
        savedKeys = Set(layout.compactMap { ChatSessionSidebarBatch.sessionPinKey($0.value as? String) })
        return layout
    }
}

@MainActor @Observable
final class ChatSessionSidebarBatch {
    enum Action: Equatable {
        case unread(Bool), category(String?), newGroup(String), archived(Bool), delete

        var patch: [String: AnyCodable] {
            switch self {
            case let .unread(value): ["unread": .init(value)]
            case let .category(value): ["category": value.map(AnyCodable.init) ?? .init(NSNull())]
            case let .newGroup(name): ["category": .init(name)]
            case let .archived(value): ["archived": .init(value)]
            case .delete: [:]
            }
        }
    }

    struct Outcome: Decodable {
        let key: String
        let ok: Bool
        let error: Failure?
        let agentId: String?
        let archiveUndoToken: String?
        struct Failure: Decodable { let message: String }
    }

    /// Display only: an old Gateway's pin order belongs to its shared config. Never write it here.
    private struct LegacyPinOrder: Decodable {
        let valid: Bool
        let config: Config
        struct Config: Decodable {
            let ui: UI?
            struct UI: Decodable {
                let prefs: Prefs?
                struct Prefs: Decodable { let sidebarEntries: [String]? }
            }
        }
    }

    private struct PinWrite: Decodable { let status: String }
    var selection = ChatSidebarSelection()
    var errors: [String: String] = [:]
    var notices: [String] = []
    var archiveUndo: ChatSidebarArchiveReceipt?
    var archiveRecoveries: [String: ChatSidebarArchiveRecovery] = [:]
    // Survives a connection reset; never retain a target, endpoint, or error from the old lease.
    var restoreNotices: Set<ChatSidebarRestoreNotice> = []
    var pendingArchives: [String: UUID] = [:]
    var running = false
    var pendingDelete: [OpenClawChatSessionEntry] = []
    private(set) var sidebarEntries: [String] = []
    private var writingPins = false
    var busy: Bool {
        self.running || self.writingPins
    }

    var scope = UUID()

    func reset(clearConnection: Bool = true) {
        self.selection = .init()
        self.pendingDelete = []
        if clearConnection {
            self.scope = UUID()
            self.running = false
            // ui/src/components/session-organizer-operations.runtime.ts:202 keeps outcomes across query navigation.
            self.errors = [:]
            self.notices = []
            self.archiveUndo = nil
            self.archiveRecoveries = [:]
            self.pendingArchives = [:]
            self.writingPins = false
            self.sidebarEntries = []
        }
    }

    func refreshPins(_ connection: OpenClawSessionMenuConnection) async throws {
        try Task.checkCancellation()
        guard !self.writingPins else { return }
        let scope = self.scope
        let entries: [String]
        if connection.supportsPersonalPins {
            guard connection.allows("users.prefs.get", scope: "operator.sessions.read") else { return }
            entries = try await connection.pinProfile.read(connection, forDisplay: true)
                .compactMap { $0.value as? String }
        } else {
            guard connection.allows("config.get", scope: "operator.read") else { return }
            let snapshot: LegacyPinOrder = try await connection.read("config.get")
            guard snapshot.valid else { throw CocoaError(.coderReadCorrupt) }
            entries = snapshot.config.ui?.prefs?.sidebarEntries ?? []
        }
        guard self.scope == scope, !self.writingPins else { return }
        self.sidebarEntries = entries
    }

    fileprivate static func sessionPinKey(_ text: String?) -> String? {
        guard let text, text.hasPrefix("session:") else { return nil }
        let key = text.dropFirst(8).trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? nil : key
    }

    var pinPositions: [String: Int] {
        Dictionary(self.sidebarEntries.enumerated().compactMap { index, entry in
            Self.sessionPinKey(entry).map { ($0, index) }
        }, uniquingKeysWith: min)
    }

    static func movingPin(_ entries: [AnyCodable], key: String, target: String?, after: Bool) throws -> [AnyCodable] {
        func pinKey(_ entry: AnyCodable) -> String? {
            Self.sessionPinKey(entry.value as? String)
        }
        // Move only existing pin slots. The original JSON, including unknown future values, is the CAS base.
        let slots = entries.indices.filter { pinKey(entries[$0]) != nil }
        var sessions = slots.map { entries[$0] }
        guard let source = sessions.firstIndex(where: { pinKey($0) == key }) else {
            throw OpenClawPersonalPinError.placementChanged
        }
        guard key != target else { return entries }
        let entry = sessions.remove(at: source)
        let destination = target.flatMap { target in sessions.firstIndex(where: { pinKey($0) == target }) }
        // Only a drop on the section itself means “at the end.” Do not reinterpret a stale row target.
        guard target == nil || destination != nil else { throw OpenClawPersonalPinError.placementChanged }
        sessions.insert(entry, at: destination.map { $0 + (after ? 1 : 0) } ?? sessions.count)
        var result = entries
        for (slot, value) in zip(slots, sessions) {
            result[slot] = value
        }
        return result
    }

    func movePin(
        key: String,
        target: String?,
        after: Bool,
        connection: OpenClawSessionMenuConnection) async throws
    {
        guard connection.supportsPersonalPins else { throw OpenClawPersonalPinError.unsupportedGateway }
        guard !self.writingPins,
              connection.allows("users.prefs.set") else { throw CancellationError() }
        let scope = self.scope
        self.writingPins = true
        // The preference belongs to the connection, not the current roster filter or selection.
        defer {
            if self.scope == scope {
                self.writingPins = false
            }
        }
        do {
            for attempt in 0..<2 {
                let previous = try await connection.pinProfile.read(connection)
                guard self.scope == scope else { return }
                do {
                    let next = try Self.movingPin(previous, key: key, target: target, after: after)
                    self.sidebarEntries = next.compactMap { $0.value as? String }
                    guard next != previous else { return }
                    let result: PinWrite = try await connection.read("users.prefs.set", [
                        "entries": .init([ChatSidebarPinProfile.pinKey: next]),
                        "expectedEntries": .init([ChatSidebarPinProfile.pinKey: previous]),
                    ])
                    guard self.scope == scope else { return }
                    if result.status == "conflict", attempt == 0 {
                        // The optimistic order was rejected, even if the retry read never succeeds.
                        self.sidebarEntries = previous.compactMap { $0.value as? String }
                        continue
                    }
                    guard result.status == "ok" else { throw CocoaError(.fileWriteUnknown) }
                } catch {
                    guard connection.isCurrent(), self.scope == scope else { throw CancellationError() }
                    self.sidebarEntries = previous.compactMap { $0.value as? String }
                    throw error
                }
                // The write was acknowledged. A newer peer order can supersede it, but a failed read cannot.
                if let latest = try? await connection.pinProfile.read(connection), self.scope == scope {
                    self.sidebarEntries = latest.compactMap { $0.value as? String }
                }
                return
            }
        } catch {
            guard connection.isCurrent(), self.scope == scope else { throw CancellationError() }
            self.notices = [error.localizedDescription]
            throw error
        }
    }

    static func allows(
        _ action: Action,
        rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection,
        method: String = "sessions.patchMany") -> Bool
    {
        if case .newGroup = action {
            return connection.allows("sessions.groups.list", scope: "operator.read") &&
                connection.allows("sessions.groups.put") && connection.allows("sessions.patchMany")
        }
        if action == .delete {
            return connection.allows(
                "sessions.delete",
                scope: rows.allSatisfy(\.isArchived) ? "operator.write" : "operator.admin")
        }
        if connection.allows(method) {
            return true
        }
        // ui/src/lib/session-method-access.ts:32,81 preflights the entire scoped batch.
        if case .archived = action {
            return connection.allows(method, scope: "operator.sessions.write") &&
                rows.allSatisfy { $0.sharingRole == .owner || $0.sharingRole == .admin }
        }
        return false
    }

    func run(
        _ action: Action,
        rows: [OpenClawChatSessionEntry],
        mainKey: String,
        connection: OpenClawSessionMenuConnection) async -> [OpenClawChatSessionEntry]
    {
        guard connection.isCurrent(), !Task.isCancelled else { return [] }
        self.errors = [:]
        self.notices = []
        guard Self.allows(action, rows: rows, connection: connection) else {
            self.fail(rows, String(localized: "This connection cannot change every selected thread."))
            return []
        }
        if case let .newGroup(name) = action {
            guard await self.createGroup(named: name, rows: rows, connection: connection) else { return [] }
        }
        let rows = rows.filter {
            switch action {
            case let .archived(value): $0.isArchived != value
            case let .category(value): $0.category != value
            default: true
            }
        }
        if case .archived = action,
           rows.contains(where: { ChatPayloadDecoding.trimmedNonEmptyString($0.sessionId) == nil ||
                   !ChatSessionSidebarEligibility.canArchive($0, mainSessionKey: mainKey)
           })
        {
            self.fail(rows, String(localized: "These threads cannot be archived or restored. Refresh and try again."))
            return []
        }
        if action == .delete {
            guard ChatSessionSidebarEligibility.canDelete(rows, mainSessionKey: mainKey) else {
                self.fail(
                    rows,
                    String(localized: "Only idle threads or an entirely archived selection can be deleted."))
                return []
            }
            let result = await ChatSessionBatchMutationRunner
                .run(keys: rows.map(OpenClawChatSessionSidebarData.identity)) { @MainActor identity in
                    guard let row = rows.first(where: { OpenClawChatSessionSidebarData.identity($0) == identity })
                    else { return }
                    let data = try await connection.request(OpenClawChatGatewayRequests.sidebarBatchDelete(row))
                    let result = try JSONDecoder().decode(SessionsDeleteResult.self, from: data)
                    guard result.deleted else {
                        throw NSError(domain: "SidebarBatch", code: 1, userInfo: [NSLocalizedDescriptionKey:
                                String(localized: "The thread was not deleted. Refresh and try again.")])
                    }
                    if let preserved = result.worktreepreserved {
                        self.notices.append(String(
                            format: String(localized: "Working copy preserved at %@ (%@)."),
                            preserved.path,
                            preserved.reason.rawValue))
                    }
                }
            guard connection.isCurrent() else { return [] }
            self.errors.merge(result.errorsByKey) { _, latest in latest }
            return rows.filter { result.succeededKeys.contains(OpenClawChatSessionSidebarData.identity($0)) }
        }
        // ui/src/components/session-organizer-operations.runtime.ts:202 ties archive outcomes to the connection.
        let pending = action == .archived(true) ? rows.compactMap { row in
            self.beginArchive(row).map { (row, $0) }
        } : []
        defer { for (row, token) in pending {
            self.finishArchive(row, token: token)
        } }
        var tokens: [String: String] = [:]
        let successful = await patch(
            action == .archived(true) ? pending.map(\.0) : rows,
            action: action,
            connection: connection)
        { row, token in
            tokens[Self.archiveIdentity(row)] = token
        }
        if action == .archived(true) {
            offerArchiveUndo(successful, connection: connection, tokens: tokens)
        }
        return successful
    }

    private func createGroup(
        named name: String,
        rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection) async -> Bool
    {
        // ui/src/components/session-organizer-operations.runtime.ts:472: capture identities before
        // catalog creation; paging must not invalidate rows that the Gateway can still guard.
        guard rows.allSatisfy({ ChatPayloadDecoding.trimmedNonEmptyString($0.sessionId) != nil }) else {
            self.fail(rows, String(localized: "Refresh these threads and try again."))
            return false
        }
        do {
            let current: OpenClawChatSessionGroupsResponse = try await connection.read("sessions.groups.list")
            if !current.groups.contains(where: { $0.name == name }) {
                // ui/src/components/session-organizer-catalog.ts:32 leaves sectionOrder untouched.
                let _: OpenClawChatSessionGroupsMutationResponse = try await connection.read("sessions.groups.put", [
                    "names": .init(current.groups.map(\.name) + [name]),
                ])
            }
            return true
        } catch {
            guard connection.isCurrent(), !Task.isCancelled else { return false }
            self.fail(rows, error.localizedDescription)
            return false
        }
    }

    func patch(
        _ rows: [OpenClawChatSessionEntry],
        action: Action,
        connection: OpenClawSessionMenuConnection,
        archived: (OpenClawChatSessionEntry, String) -> Void = { _, _ in }) async -> [OpenClawChatSessionEntry]
    {
        struct Response: Decodable { let outcomes: [Outcome] }
        var successful: [OpenClawChatSessionEntry] = []
        var errors: [String: String] = [:]
        // ui/src/components/session-organizer-batch-mutations.ts:129 and sessions-patch.ts:9:
        // sequential chunks retain earlier successes when a later request fails.
        func requestsUndo(_ row: OpenClawChatSessionEntry) -> Bool {
            action == .archived(true) && connection.requestsArchiveUndo(for: row)
        }
        var remaining = rows[...]
        while let first = remaining.first {
            guard connection.isCurrent(), !Task.isCancelled else { return [] }
            // patchMany shares one patch across targets. Keep adjacent like requests in selection order.
            let requestUndo = requestsUndo(first)
            let chunk = remaining.prefix(100).prefix { requestsUndo($0) == requestUndo }
            var fields = action.patch
            if requestUndo { fields["requestArchiveUndo"] = .init(true) }
            do {
                let data = try await connection.request(OpenClawChatGatewayRequests.sidebarBatchPatch(
                    Array(chunk),
                    patch: fields))
                let response = try JSONDecoder().decode(Response.self, from: data)
                guard response.outcomes.count == chunk.count,
                      zip(chunk, response.outcomes).allSatisfy({ row, outcome in
                          guard row.key == outcome.key else { return false }
                          guard requestUndo else { return true }
                          let expected = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
                          return outcome
                              .agentId == expected ||
                              (outcome.agentId == nil && OpenClawChatSessionKey.agentID(from: row.key) != nil)
                      })
                else {
                    throw CocoaError(.coderReadCorrupt)
                }
                for (row, outcome) in zip(chunk, response.outcomes) {
                    if outcome.ok {
                        successful.append(row)
                        if requestUndo, let token = outcome.archiveUndoToken, !token.isEmpty {
                            archived(row, token)
                        }
                    } else {
                        errors[OpenClawChatSessionSidebarData.identity(row)] = outcome.error?
                            .message ?? String(localized: "The thread operation failed.")
                    }
                }
            } catch {
                guard connection.isCurrent(), !Task.isCancelled else { return [] }
                for row in remaining {
                    errors[OpenClawChatSessionSidebarData.identity(row)] = error.localizedDescription
                }
                break
            }
            remaining = remaining.dropFirst(chunk.count)
        }
        // Preserve failures published by other operations after this one began.
        self.errors.merge(errors) { _, latest in latest }
        return successful
    }

    private func fail(_ rows: [OpenClawChatSessionEntry], _ message: String) {
        for row in rows {
            self.errors[OpenClawChatSessionSidebarData.identity(row)] = message
        }
    }

    enum Drop {
        case selfDrop
        case mutation([String: AnyCodable]?)
        /// Pin through the Gateway's session checks, then place the new pin beside a saved one.
        case insert(key: String, target: String)
    }

    static func drop(
        _ row: OpenClawChatSessionEntry,
        section: String,
        target: OpenClawChatSessionEntry? = nil,
        now: Date = .now) -> Drop?
    {
        if section == "pinned" {
            // ui/src/components/session-organizer.ts handleSidebarZoneDrop consumes self-drops before bubbling.
            if let target, OpenClawChatSessionSidebarData.identity(row) ==
                OpenClawChatSessionSidebarData.identity(target)
            {
                return .selfDrop
            }
            guard ChatSessionSidebarEligibility.canPin(row), !row.isSnoozed(at: now) else { return nil }
            if row.pinned == true {
                return .mutation(nil)
            }
            guard let target else { return .mutation(["pinned": .init(true)]) }
            func canonical(_ row: OpenClawChatSessionEntry) -> String {
                OpenClawChatSessionTarget.resolve(
                    row.key, selectedAgentID: row.agentId, policy: .scopeBareKeysToSelectedAgent).sessionKey
            }
            return .insert(key: canonical(row), target: canonical(target))
        }
        // Category patches: ui/src/components/session-organizer-operations.runtime.ts assignSessionCategory.
        // Web drop entry points: session-organizer.ts sectionDrop and handleSessionListDrop.
        if section.hasPrefix("group:") || section == "recent" {
            let category = section == "recent" ? nil : String(section.dropFirst(6))
            var patch = row.category == category ? [:] : Action.category(category).patch
            if row.pinned == true {
                patch["pinned"] = .init(false)
            }
            return patch.isEmpty ? nil : .mutation(patch)
        }
        return section == "list" && row.pinned == true ? .mutation(["pinned": .init(false)]) : nil
    }

    nonisolated static func canReorderSection(_ id: String) -> Bool {
        id.hasPrefix("group:") || ["recent", "groups", "work"].contains(id)
    }

    nonisolated static func sectionToken(_ id: String) -> String {
        if id.hasPrefix("group:") {
            return "category:" + id.dropFirst(6)
        }
        return id == "recent" ? "ungrouped" : id
    }

    static func orderedSections(_ stored: [String], groups: [String]) -> [String] {
        let builtins = ["ungrouped", "groups", "work"]
        var order: [String] = []
        // ui/src/lib/sessions/grouping.ts:72: preserve saved catalog slots even when not rendered.
        for token in stored where !order.contains(token) {
            if builtins.contains(token) || token.hasPrefix("catalog:") ||
                (token.hasPrefix("category:") && groups.contains(String(token.dropFirst(9))))
            {
                order.append(token)
            }
        }
        for group in groups where !order.contains("category:\(group)") {
            order.insert("category:\(group)", at: order.firstIndex(where: { builtins.contains($0) }) ?? order.count)
        }
        for (index, token) in builtins.enumerated() where !order.contains(token) {
            let slot = index == 0 ? order.count : (order.firstIndex(of: builtins[index - 1])! + 1)
            order.insert(token, at: slot)
        }
        return order
    }

    func moveSection(
        _ source: String,
        to target: String,
        after: Bool,
        connection: OpenClawSessionMenuConnection) async throws -> OpenClawChatSessionGroupsResponse
    {
        let current: OpenClawChatSessionGroupsResponse = try await connection.read("sessions.groups.list")
        var order = Self.orderedSections(current.sectionOrder ?? [], groups: current.groups.map(\.name))
        let source = Self.sectionToken(source)
        let target = Self.sectionToken(target)
        guard source != target, order.contains(source), order.contains(target) else { return current }
        order.removeAll { $0 == source }
        order.insert(source, at: order.firstIndex(of: target)! + (after ? 1 : 0))
        let names = order.filter { $0.hasPrefix("category:") }.map { String($0.dropFirst(9)) }
        return try await connection.read("sessions.groups.put", ["names": .init(names), "sectionOrder": .init(order)])
    }
}
#endif
