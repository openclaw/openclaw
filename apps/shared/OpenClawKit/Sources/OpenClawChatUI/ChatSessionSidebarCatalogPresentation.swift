#if os(macOS)
import Foundation
import OpenClawProtocol

@MainActor
struct ChatSidebarCatalogPresentation {
    struct Host: Identifiable {
        let source: SessionCatalogHost
        let rows: [SessionCatalogSession]
        var id: String {
            self.source.hostid
        }
    }

    struct Catalog: Identifiable {
        let source: SessionCatalog
        let hosts: [Host]
        var id: String {
            self.source.id
        }
    }

    struct VisibilityOption: Identifiable {
        let id: String
        let label: String
    }

    static func visibilityOptions(_ catalogs: [SessionCatalog], hidden: Set<String>) -> [VisibilityOption] {
        let known = Set(catalogs.map(\.id))
        return catalogs.map { .init(id: $0.id, label: $0.label) } + hidden.subtracting(known).sorted().map {
            .init(id: $0, label: $0)
        }
    }

    let catalogs: [Catalog]
    let liveRows: [String: OpenClawChatSessionEntry]

    var hasVisibleRows: Bool {
        self.catalogs.contains { !$0.hosts.isEmpty }
    }

    init(
        sources: [SessionCatalog],
        requestErrors: [String: String] = [:],
        query: OpenClawChatSidebarQuery,
        allAgents: Bool,
        now: Date = .now,
        lookup: (String) -> OpenClawChatSessionEntry?)
    {
        var liveRows: [String: OpenClawChatSessionEntry] = [:]
        for key in sources.flatMap(\.hosts).flatMap(\.sessions).compactMap(\.sessionkey) {
            liveRows[key] = lookup(key)
        }
        self.liveRows = liveRows
        // app-sidebar.ts:464 uses the all-agent roster instead of catalog sections.
        let sources = query.status == .archived || allAgents ? [] : sources
        // app-sidebar-session-ownership.ts:93: involvement is Gateway-owned, never an owner filter.
        let owner = query.involvingMe == true ? nil : query.ownerId
        self.catalogs = sources.compactMap { catalog in
            let hosts = catalog.hosts.compactMap { host -> Host? in
                let rows = ChatSessionSidebarCatalogs.filtered(host.sessions, owner: owner, live: liveRows).filter {
                    // The roster retains canonical lifecycle facts after a row leaves the current query.
                    guard let key = $0.sessionkey, let live = liveRows[key] else { return true }
                    return query.status.includes(live, now: now)
                }
                return rows.isEmpty ? nil : Host(source: host, rows: rows)
            }
            let failed = !Self.errors(catalog, requestError: requestErrors[catalog.id]).isEmpty
            return hosts.isEmpty && !failed ? nil : Catalog(source: catalog, hosts: hosts)
        }
    }

    static func ordinarySections(
        _ sections: [ChatSessionSidebarModel.Section],
        excluding: Set<String>,
        rankedSearch: Bool = false,
        currentKey: String,
        currentIsKnown: Bool) -> [ChatSessionSidebarModel.Section]
    {
        // lib/sessions/navigation.ts:253 never synthesizes an ordinary row for an unadopted catalog route.
        let rawCatalog = !currentIsKnown && OpenClawChatSessionKey.catalogSource(currentKey) != nil ? currentKey : nil
        guard !excluding.isEmpty || rawCatalog != nil else { return sections }
        return sections.map { section in
            let nodes: [ChatSessionSidebarModel.Node]
            if rankedSearch {
                // Search owns flat relevance order; rebuilding its tree hides matching children.
                nodes = section.nodes.filter { $0.session.key != rawCatalog }
            } else {
                func retained(_ node: ChatSessionSidebarModel.Node) -> [ChatSessionSidebarModel.Node] {
                    let children = node.children.flatMap(retained)
                    if excluding.contains(node.id) || node.id == rawCatalog { return children }
                    // Catalog placement must not unfold runs or discard the tree owner's pending child reads.
                    return [.init(
                        session: node.session,
                        children: children,
                        badges: node.badges,
                        foldedSessions: node.foldedSessions,
                        loadParentKeys: node.loadParentKeys,
                        hasNavigationChildren: node.hasNavigationChildren)]
                }
                nodes = section.nodes.flatMap(retained)
            }
            return .init(id: section.id, title: section.title, nodes: nodes)
        }
    }

    static func target(catalogID: String, hostID: String, row: SessionCatalogSession, agentID: String)
        -> OpenClawChatSessionTarget
    {
        guard let key = row.sessionkey else {
            return self.sourceTarget(catalogID: catalogID, hostID: hostID, row: row, agentID: agentID)
        }
        return .init(sessionKey: key, agentID: OpenClawChatSessionKey.agentID(from: key) ?? agentID)
    }

    static func sourceTarget(catalogID: String, hostID: String, row: SessionCatalogSession, agentID: String)
        -> OpenClawChatSessionTarget
    {
        let allowed =
            CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let parts = [catalogID, hostID, row.threadid].map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }
        // ui/src/lib/sessions/catalog-key.ts:80 keeps the source independent of its adopted conversation.
        return .init(
            sessionKey: "agent:\(agentID.lowercased()):catalog:" + parts.joined(separator: ":"),
            agentID: agentID.lowercased())
    }

    static func shouldLeaveDeletedSource(
        _ source: OpenClawChatSessionTarget,
        current: OpenClawChatSessionTarget) -> Bool
    {
        // app-sidebar-catalog-menu.ts:155 compares source IDs even when its row has since been adopted.
        guard let identity = OpenClawChatSessionKey.catalogSource(source.sessionKey) else { return false }
        return source.agentID == current.agentID && identity == OpenClawChatSessionKey.catalogSource(current.sessionKey)
    }

    static func title(_ row: SessionCatalogSession) -> String {
        row.name.flatMap { $0.isEmpty ? nil : $0 } ?? row.threadid
    }

    static func errors(_ catalog: SessionCatalog, requestError: String?) -> [String] {
        var seen = Set<String>()
        let errors = [catalog.error] + catalog.hosts.compactMap {
            $0.error?["code"]?.value as? String == "NODE_OFFLINE" ? nil : $0.error
        }
        return ([requestError] + errors.compactMap { error -> String? in
            guard let error else { return nil }
            return [
                (error["code"]?.value as? String).map { "[\($0)]" }, error["message"]?.value as? String,
            ].compactMap(\.self).joined(separator: " ")
        }).compactMap(\.self).filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
#endif
