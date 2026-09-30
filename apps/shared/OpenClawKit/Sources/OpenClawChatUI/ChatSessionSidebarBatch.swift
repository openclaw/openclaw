#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol

struct ChatSidebarSelection {
    var keys: Set<String> = []
    var active = false

    struct Node: Identifiable {
        let id: String
        let row: ChatSessionSidebarModel.Node
        let children: [Self]?

        @MainActor
        init(_ row: ChatSessionSidebarModel.Node, identity: (OpenClawChatSessionEntry) -> String) {
            self.id = identity(row.session)
            self.row = row
            self.children = row.children.isEmpty ? nil : row.children.map { Self($0, identity: identity) }
        }
    }

    static func visibleRoots(
        in sections: [ChatSessionSidebarModel.Section], searching: Bool,
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
        case unread(Bool), category(String?), archived(Bool), delete

        var patch: [String: AnyCodable] {
            switch self {
            case let .unread(value): ["unread": .init(value)]
            case let .category(value): ["category": value.map(AnyCodable.init) ?? .init(NSNull())]
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

    struct Groups: Decodable {
        let groups: [OpenClawChatSessionGroup]
    }

    var selection = ChatSidebarSelection()
    var errors: [String: String] = [:]
    var notices: [String] = []
    var running = false
    var pendingDelete: [OpenClawChatSessionEntry] = []
    var connection: OpenClawSessionMenuConnection?
    var scope = UUID()

    func reset(clearConnection: Bool = true) {
        self.selection = .init()
        self.errors = [:]
        self.notices = []
        self.running = false
        self.pendingDelete = []
        if clearConnection { self.connection = nil }
        self.scope = UUID()
    }

    static func allows(
        _ action: Action,
        rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection) -> Bool
    {
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
        _ action: Action, rows: [OpenClawChatSessionEntry], mainKey: String,
        connection: OpenClawSessionMenuConnection) async -> [OpenClawChatSessionEntry]
    {
        let scope = self.scope
        self.errors = [:]
        self.notices = []
        guard Self.allows(action, rows: rows, connection: connection) else {
            self.fail(rows, String(localized: "This connection cannot change every selected thread."))
            return []
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

    func patch(
        _ rows: [OpenClawChatSessionEntry], fields: [String: AnyCodable],
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
                    if outcome.ok { successful.append(row) }
                    else {
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
}
#endif
