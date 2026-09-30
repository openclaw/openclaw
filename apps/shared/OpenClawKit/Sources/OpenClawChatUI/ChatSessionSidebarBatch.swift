#if os(macOS)
import Foundation
import Observation
import struct OpenClawKit.GatewayResponseError
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
        struct Failure: Decodable { let message: String }
    }

    struct PinSnapshot: Decodable {
        let valid: Bool
        let hash: String
        let config: Config
        struct Config: Decodable {
            let ui: UI?
            struct UI: Decodable {
                let prefs: Prefs?
                struct Prefs: Decodable { let sidebarEntries: [String]? }
            }
        }

        func entries() throws -> [String] {
            guard self.valid else { throw CocoaError(.coderReadCorrupt) }
            // ui/src/app-navigation.ts:59: absence uses page defaults; explicit [] hides them.
            return self.config.ui?.prefs?.sidebarEntries ??
                ["route:agents-home", "route:dashboards", "route:systems", "route:cron", "route:plugins"]
        }
    }

    var selection = ChatSidebarSelection()
    var errors: [String: String] = [:]
    var notices: [String] = []
    var running = false
    var pendingDelete: [OpenClawChatSessionEntry] = []
    private(set) var sidebarEntries: [String] = []
    private var pinRevision = 0
    private var writingPins = false
    private var pinRefreshPending = false
    var busy: Bool {
        self.running || self.writingPins
    }

    var scope = UUID()

    func reset(clearConnection: Bool = true) {
        self.selection = .init()
        self.errors = [:]
        self.notices = []
        self.running = false
        self.pendingDelete = []
        if clearConnection {
            self.pinRevision += 1
            self.writingPins = false
            self.pinRefreshPending = false
            self.sidebarEntries = []
        }
        self.scope = UUID()
    }

    func refreshPins(_ connection: OpenClawSessionMenuConnection) async throws {
        try Task.checkCancellation()
        guard connection.allows("config.get", scope: "operator.read") else { return }
        if self.writingPins { self.pinRefreshPending = true
            return
        }
        self.pinRevision += 1
        let revision = self.pinRevision
        let snapshot: PinSnapshot = try await connection.read("config.get")
        if revision == self.pinRevision { self.sidebarEntries = try snapshot.entries() }
    }

    private func reconcilePins(_ connection: OpenClawSessionMenuConnection, revision: Int) async throws {
        // A config.changed event can arrive during the post-ack read. Drain it before publishing the mirror.
        repeat {
            self.pinRefreshPending = false
            do {
                let committed: PinSnapshot = try await connection.read("config.get")
                guard revision == self.pinRevision else { throw CancellationError() }
                if !self.pinRefreshPending { self.sidebarEntries = try committed.entries() }
            } catch {
                guard revision == self.pinRevision, self.pinRefreshPending else { throw error }
            }
        } while self.pinRefreshPending
    }

    static func movingPin(_ entries: [String], keys: [String], key: String, target: String?, after: Bool) -> [String] {
        // app-navigation.ts persists session:<key>; Gateway ordinary keys already include their agent.
        // Raw global/unknown sentinels share the web preference slot, not a native-only identity format.
        guard key != target else { return entries }
        // Keep foreign slots fixed. Unpinning changes session state, not this array's slot count.
        var result = entries
        for key in keys where !result.contains("session:\(key)") {
            result.append("session:\(key)")
        }
        let slots = result.indices.filter {
            result[$0].hasPrefix("session:") && !result[$0].dropFirst(8).trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
        }
        var sessions = slots.map { result[$0] }
        guard let source = sessions.firstIndex(of: "session:\(key)") else { return entries }
        let entry = sessions.remove(at: source)
        let destination = target.flatMap { sessions.firstIndex(of: "session:\($0)") }
        sessions.insert(entry, at: destination.map { $0 + (after ? 1 : 0) } ?? sessions.count)
        for (slot, value) in zip(slots, sessions) {
            result[slot] = value
        }
        return result
    }

    func movePin(
        keys: [String],
        key: String,
        target: String?,
        after: Bool,
        connection: OpenClawSessionMenuConnection) async throws
    {
        guard !self.writingPins,
              connection.allows("config.patch", scope: "operator.admin") else { throw CancellationError() }
        self.writingPins = true
        self.pinRevision += 1
        let revision = self.pinRevision
        // The preference belongs to the connection, not the current roster filter or selection.
        defer { if revision == self.pinRevision { self.writingPins = false } }
        do {
            for attempt in 0..<2 {
                let snapshot: PinSnapshot = try await connection.read("config.get")
                guard revision == self.pinRevision else { throw CancellationError() }
                let previous = try snapshot.entries()
                self.sidebarEntries = Self.movingPin(previous, keys: keys, key: key, target: target, after: after)
                do {
                    // ui/src/app/server-prefs.ts:549 uses this same leaf replacement. The config.patch baseHash
                    // guard protects foreign slots; a conflict recomputes the move instead of replaying stale bytes.
                    try await connection.request(OpenClawChatGatewayRequests.sidebarPinOrder(
                        self.sidebarEntries,
                        hash: snapshot.hash))
                } catch {
                    guard revision == self.pinRevision else { throw CancellationError() }
                    self.sidebarEntries = previous
                    // ui/src/lib/config/config-mutation-error.ts:40 identifies this existing conflict response.
                    if attempt == 0, let error = error as? GatewayResponseError,
                       error.code == "INVALID_REQUEST",
                       error.details["publication"] == nil,
                       error.message.contains("config changed since last load") { continue }
                    throw error
                }
                try await self.reconcilePins(connection, revision: revision)
                return
            }
        } catch {
            guard revision == self.pinRevision else { throw CancellationError() }
            self.notices = [error.localizedDescription]
            if self.pinRefreshPending { try? await self.reconcilePins(connection, revision: revision) }
            throw error
        }
    }

    static func allows(
        _ action: Action,
        rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection) -> Bool
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
        if connection.allows("sessions.patchMany") { return true }
        // ui/src/lib/session-method-access.ts:32,81 preflights the entire scoped batch.
        if case .archived = action {
            return connection.allows("sessions.patchMany", scope: "operator.sessions.write") &&
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
        let scope = self.scope
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
                    guard self.scope == scope else { throw CancellationError() }
                    guard let row = rows.first(where: { OpenClawChatSessionSidebarData.identity($0) == identity })
                    else { return }
                    let data = try await connection.request(OpenClawChatGatewayRequests.sidebarBatchDelete(row))
                    let result = try JSONDecoder().decode(SessionsDeleteResult.self, from: data)
                    guard self.scope == scope else { throw CancellationError() }
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
            guard self.scope == scope else { return [] }
            self.errors = result.errorsByKey
            return rows.filter { result.succeededKeys.contains(OpenClawChatSessionSidebarData.identity($0)) }
        }
        return await self.patch(rows, fields: action.patch, connection: connection)
    }

    private func createGroup(
        named name: String,
        rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection) async -> Bool
    {
        let scope = self.scope
        // ui/src/components/session-organizer-operations.runtime.ts:472: capture identities before
        // catalog creation; paging must not invalidate rows that the Gateway can still guard.
        guard rows.allSatisfy({ ChatPayloadDecoding.trimmedNonEmptyString($0.sessionId) != nil }) else {
            self.fail(rows, String(localized: "Refresh these threads and try again."))
            return false
        }
        do {
            let current: Groups = try await connection.read("sessions.groups.list")
            guard self.scope == scope else { return false }
            if !current.groups.contains(where: { $0.name == name }) {
                // ui/src/components/session-organizer-catalog.ts:32 leaves sectionOrder untouched.
                let _: Groups = try await connection.read("sessions.groups.put", [
                    "names": .init(current.groups.map(\.name) + [name]),
                ])
                guard self.scope == scope else { return false }
            }
            return true
        } catch {
            guard self.scope == scope, connection.isCurrent(), !Task.isCancelled else { return false }
            self.fail(rows, error.localizedDescription)
            return false
        }
    }

    func patch(
        _ rows: [OpenClawChatSessionEntry],
        fields: [String: AnyCodable],
        connection: OpenClawSessionMenuConnection) async -> [OpenClawChatSessionEntry]
    {
        struct Response: Decodable { let outcomes: [Outcome] }
        let scope = self.scope
        var successful: [OpenClawChatSessionEntry] = []
        self.errors = [:]
        // ui/src/components/session-organizer-batch-mutations.ts:129 and sessions-patch.ts:9:
        // sequential chunks retain earlier successes when a later request fails.
        for offset in stride(from: 0, to: rows.count, by: 100) {
            guard scope == self.scope else { return [] }
            let chunk = Array(rows[offset..<min(offset + 100, rows.count)])
            do {
                let data = try await connection.request(OpenClawChatGatewayRequests.sidebarBatchPatch(
                    chunk,
                    patch: fields))
                let response = try JSONDecoder().decode(Response.self, from: data)
                guard scope == self.scope else { return [] }
                guard response.outcomes.map(\.key) == chunk.map(\.key) else {
                    throw CocoaError(.coderReadCorrupt)
                }
                for (row, outcome) in zip(chunk, response.outcomes) {
                    if outcome.ok { successful.append(row) } else {
                        self.errors[OpenClawChatSessionSidebarData.identity(row)] = outcome.error?
                            .message ?? String(localized: "The thread operation failed.")
                    }
                }
            } catch {
                guard scope == self.scope else { return [] }
                self.fail(Array(rows[offset...]), error.localizedDescription)
                break
            }
        }
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
    }

    static func drop(
        _ row: OpenClawChatSessionEntry,
        section: String,
        target: OpenClawChatSessionEntry? = nil) -> Drop?
    {
        if section == "pinned" {
            // ui/src/components/session-organizer-controller.ts:281 consumes self-drops before list unpinning.
            if let target, OpenClawChatSessionSidebarData.identity(row) ==
                OpenClawChatSessionSidebarData.identity(target) { return .selfDrop }
            guard ChatSessionSidebarEligibility.canPin(row) else { return nil }
            return .mutation(row.pinned == true ? nil : ["pinned": .init(true)])
        }
        // ui/src/components/session-organizer-controller.ts:656 unpins atomically with category assignment;
        // dropping onto the broad list at :354 instead preserves category.
        if section.hasPrefix("group:") || section == "recent" {
            let category = section == "recent" ? nil : String(section.dropFirst(6))
            guard row.category != category || row.pinned == true else { return nil }
            var patch: [String: AnyCodable] =
                ["category": section == "recent" ? .init(NSNull()) : .init(String(section.dropFirst(6)))]
            if row.pinned == true { patch["pinned"] = .init(false) }
            return .mutation(patch)
        }
        return section == "list" && row.pinned == true ? .mutation(["pinned": .init(false)]) : nil
    }

    nonisolated static func canReorderSection(_ id: String) -> Bool {
        id.hasPrefix("group:") || ["recent", "groups", "work"].contains(id)
    }

    nonisolated static func sectionToken(_ id: String) -> String {
        if id.hasPrefix("group:") { return "category:" + id.dropFirst(6) }
        return id == "recent" ? "ungrouped" : id
    }

    static func orderedSections(_ stored: [String], groups: [String]) -> [String] {
        let builtins = ["ungrouped", "groups", "work"]
        var order: [String] = []
        // ui/src/lib/sessions/grouping.ts:72: preserve saved catalog slots even when not rendered.
        for token in stored where !order.contains(token) {
            if builtins.contains(token) || token.hasPrefix("catalog:") ||
                (token.hasPrefix("category:") && groups.contains(String(token.dropFirst(9))))
            { order.append(token) }
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
        let scope = self.scope
        let current: OpenClawChatSessionGroupsResponse = try await connection.read("sessions.groups.list")
        guard scope == self.scope else { throw CancellationError() }
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
