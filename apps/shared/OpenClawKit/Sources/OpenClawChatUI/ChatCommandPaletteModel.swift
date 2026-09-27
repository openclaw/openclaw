#if os(macOS)
import Foundation

enum ChatCommandPaletteAction: String, CaseIterable {
    case newThread, threads, find, export

    var title: String {
        switch self {
        case .newThread: String(localized: "New Thread")
        case .threads: String(localized: "Threads…")
        case .find: String(localized: "Find in Conversation")
        case .export: String(localized: "Export Transcript…")
        }
    }

    var symbol: String {
        switch self {
        case .newThread: "square.and.pencil"
        case .threads: "rectangle.stack"
        case .find: "magnifyingglass"
        case .export: "square.and.arrow.up"
        }
    }

    var shortcut: String {
        switch self {
        case .newThread: "⇧⌘N"
        case .threads: "⇧⌘S"
        case .find: "⌘F"
        case .export: "⇧⌘E"
        }
    }
}

enum ChatCommandPaletteItem: Identifiable {
    case agent(OpenClawChatAgentChoice)
    case thread(ChatSessionSidebarModel.Node)
    case action(ChatCommandPaletteAction)

    var id: String {
        switch self {
        case let .agent(agent): "agent:\(agent.id)"
        case let .thread(node): "thread:\(node.id)"
        case let .action(action): "action:\(action.rawValue)"
        }
    }

    var group: String {
        switch self {
        case .agent: String(localized: "Agents")
        case .thread: String(localized: "Threads")
        case .action: String(localized: "Actions")
        }
    }
}

enum ChatCommandPaletteModel {
    static func matchRank(_ query: String, fields: [String?]) -> Int {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return 1 }
        let fields = fields.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        if fields.contains(query) { return 3 }
        if fields.contains(where: { $0.hasPrefix(query) }) { return 2 }
        return fields.contains(where: { $0.contains(query) }) ? 1 : 0
    }

    static func items(
        agents: [OpenClawChatAgentChoice],
        activeAgentID: String?,
        sections: [ChatSessionSidebarModel.Section],
        remote: [OpenClawChatSessionEntry],
        query: String,
        preview: (OpenClawChatSessionEntry) -> String?) -> [ChatCommandPaletteItem]
    {
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        func flatten(_ node: ChatSessionSidebarModel.Node) -> [ChatSessionSidebarModel.Node] {
            [node] + node.children.flatMap(flatten)
        }
        let local = sections.flatMap(\.nodes).flatMap(flatten)
        var seen = Set(local.map { ChatCommandPaletteItem.thread($0).id })
        // Loaded rows own live badges and labels. Search supplies only missing rows,
        // and never writes a partial result back into the sidebar's session roster.
        let remoteNodes = searching ? ChatSessionSidebarModel.tree(from: remote.filter {
            !$0.isArchived && !ChatSessionSidebarModel.isHiddenInternalSession($0.key) &&
                ChatSessionSidebarModel.isSessionInActiveAgentScope(
                    key: $0.key, agentID: $0.agentId, activeAgentID: activeAgentID)
        }).flatMap(flatten) : []
        let remoteIDs = Set(remoteNodes.map { ChatCommandPaletteItem.thread($0).id })
        let older = remoteNodes.filter { seen.insert(ChatCommandPaletteItem.thread($0).id).inserted }
        let ranked = (local + older).enumerated().compactMap { offset, node -> (
            Int,
            Int,
            ChatSessionSidebarModel.Node)? in
            let row = node.session
            let agentID = row.agentId ?? OpenClawChatSessionKey.agentID(from: row.key) ?? activeAgentID
            let agent = agents.first { $0.id.caseInsensitiveCompare(agentID ?? "") == .orderedSame }
            let rank = self.matchRank(query, fields: [
                ChatSessionSidebarModel.displayName(for: row), row.key, row.label, row.subject,
                row.category, row.kind, row.model, row.modelProvider, agent?.displayName, agentID, preview(row),
            ])
            let effectiveRank = max(rank, remoteIDs.contains(ChatCommandPaletteItem.thread(node).id) ? 1 : 0)
            return effectiveRank > 0 ? (effectiveRank, offset, node) : nil
        }.sorted { lhs, rhs in
            if searching, lhs.0 != rhs.0 { return lhs.0 > rhs.0 }
            if searching, (lhs.2.session.updatedAt ?? 0) != (rhs.2.session.updatedAt ?? 0) {
                return (lhs.2.session.updatedAt ?? 0) > (rhs.2.session.updatedAt ?? 0)
            }
            return lhs.1 < rhs.1
        }
        let agentItems = agents.enumerated().compactMap { offset, agent -> (Int, Int, OpenClawChatAgentChoice)? in
            let rank = self.matchRank(query, fields: [agent.displayName, agent.id])
            return rank > 0 ? (rank, offset, agent) : nil
        }.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 > $1.0 }.map { ChatCommandPaletteItem.agent($0.2) }
        return agentItems + ranked.map { .thread($0.2) } + ChatCommandPaletteAction.allCases
            .filter { self.matchRank(query, fields: [$0.title]) > 0 }.map(ChatCommandPaletteItem.action)
    }

    static func selection(in ids: [String], current: String?, direction: Int = 0) -> String? {
        guard !ids.isEmpty else { return nil }
        let index = current.flatMap { ids.firstIndex(of: $0) } ?? 0
        return ids[(index + direction + ids.count) % ids.count]
    }
}

/// Presentation-scoped results, not a second session cache. A generation also
/// fences A → B → A searches whose transports finish after cancellation.
struct ChatCommandPaletteSearch {
    struct Request: Equatable {
        let query: String
        let target: OpenClawChatSessionTarget
    }

    private(set) var generation: UInt64 = 0
    private(set) var request: Request?
    private var matches: [OpenClawChatSessionEntry] = []
    private(set) var isLoading = false

    mutating func begin(_ request: Request) -> UInt64 {
        self.generation &+= 1
        self.request = request
        self.matches = []
        self.isLoading = !request.query.isEmpty
        return self.generation
    }

    mutating func complete(_ matches: [OpenClawChatSessionEntry], generation: UInt64) {
        guard generation == self.generation else { return }
        self.matches = matches
        self.isLoading = false
    }

    func rows(for request: Request) -> [OpenClawChatSessionEntry] {
        self.request == request ? self.matches : []
    }
}
#endif
