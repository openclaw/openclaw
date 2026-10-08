import Foundation
import OpenClawProtocol

extension ChatSessionSidebarModel {
    static func groupedSections(
        _ rows: [OpenClawChatSessionEntry],
        groups: [OpenClawChatSessionGroup],
        options: ViewOptions,
        peopleAvailable: Bool,
        selfOwnerID: String?,
        sectionOrder: [String],
        identity: (OpenClawChatSessionEntry) -> String = { $0.key }) -> [Section]
    {
        let grouping = options.effectiveGrouping(peopleAvailable: peopleAvailable)
        let known = groups.sorted { $0.position == $1.position ? $0.name < $1.name : $0.position < $1.position }
            .map(\.name)
        var buckets: [String: [Node]] = [:]
        var titles: [String: String] = [:]
        var people: [String: OpenClawChatSessionEntry.CreatedActor] = [:]
        var personOrder: [String] = []
        var projects: [String: String] = [:]
        var categories = grouping == .category ? known : []
        var returnToGroups = false
        // ui/src/components/app-sidebar-session-tree.ts:102: archived parents never expose descendants, even in All.
        func childIdentity(_ key: String, parent: OpenClawChatSessionEntry) -> String {
            var child = parent
            child.key = key
            child.agentId = Self.sidebarAgentID(parent)
            return identity(child)
        }
        let byKey = Dictionary(rows.map { (identity($0), $0) }, uniquingKeysWith: { first, _ in first })
        let curatedKeys = Set(byKey.values.filter {
            $0.pinned == true || ChatPayloadDecoding.trimmedNonEmptyString($0.category) != nil
        }.map(identity))
        var hidden = Set<String>()
        var pending = rows.filter(\.isArchived).flatMap { row in
            (row.childSessions ?? []).map { childIdentity($0, parent: row) }
        }
        while let key = pending.popLast() {
            guard !curatedKeys.contains(key), hidden.insert(key).inserted else { continue }
            pending += byKey[key].map { row in
                (row.childSessions ?? []).map { childIdentity($0, parent: row) }
            } ?? []
        }
        let eligible = rows.filter { !hidden.contains(identity($0)) }.map { row in
            var row = row
            // ui/src/components/app-sidebar-session-tree.ts:92,105: curated children own root placement.
            row.childSessions = row.childSessions?.filter { !curatedKeys.contains(childIdentity($0, parent: row)) }
            return row
        }
        for node in self.nodes(self.tree(from: eligible, identity: identity), matchingOwner: options.ownerID) {
            let row = node.session
            let id: String
            let category = ChatPayloadDecoding.trimmedNonEmptyString(row.category)
            if row.pinned == true {
                id = "pinned"
            } else if grouping == .none {
                id = "recent"
            } else if grouping == .project, let path = self.projectPath(row) {
                id = "project:\(path)"
                projects[id] = path
                titles[id] = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
            } else if grouping == .person, let actor = row.owner?.actor,
                      let identity = actor.identity, let ownerID = self.identityField(identity, "id"), !ownerID.isEmpty
            {
                id = "person:\(self.identityKey(identity))"
                // ui/src/lib/sessions/grouping.ts:309 retains the first projected owner for each identity.
                if people[id] == nil {
                    personOrder.append(id)
                    people[id] = actor
                    titles[id] = actor.label.flatMap { $0.isEmpty ? nil : $0 } ?? ownerID
                }
            } else if grouping == .category, let category {
                id = "group:\(category)"
                titles[id] = category
                if !categories.contains(category) { categories.append(category) }
                returnToGroups = returnToGroups || row.kind == "group"
            } else if row.kind == "group" {
                id = "groups"
            } else if row.worktree != nil || row.repository != nil || row.execNode != nil ||
                self.isCodingSessionKey(row.key)
            {
                id = "work"
            } else {
                id = "recent"
            }
            buckets[id, default: []].append(node)
        }
        // ui/src/lib/sessions/grouping.ts:348,373: self, humans, agents; projects by basename then full path.
        func personRank(_ actor: OpenClawChatSessionEntry.CreatedActor) -> Int {
            guard let identity = actor.identity else { return 1 }
            return self.identityField(identity, "type") == "agent" ? 2 :
                self.identityField(identity, "type") == "profile" && self
                .identityField(identity, "id") == selfOwnerID ? 0 : 1
        }
        let personIDs = personOrder.sorted {
            let left = people[$0]!, right = people[$1]!
            if personRank(left) != personRank(right) { return personRank(left) < personRank(right) }
            let comparison = (titles[$0] ?? "").localizedCompare(titles[$1] ?? "")
            let leftID = left.identity.flatMap { self.identityField($0, "id") } ?? ""
            let rightID = right.identity.flatMap { self.identityField($0, "id") } ?? ""
            return comparison == .orderedSame ? leftID.localizedCompare(rightID) == .orderedAscending :
                comparison == .orderedAscending
        }
        let projectIDs = projects.keys.sorted {
            let comparison = (titles[$0] ?? "").localizedCompare(titles[$1] ?? "")
            return comparison == .orderedSame ? $0
                .localizedCompare($1) == .orderedAscending : comparison == .orderedAscending
        }
        categories = categories.filter { known.contains($0) } + categories.filter { !known.contains($0) }
            .sorted { $0.localizedCompare($1) == .orderedAscending }
        let zones = self.orderedZones(sectionOrder, categories: categories)
        let ids = ["pinned"] + personIDs + projectIDs + zones
        let hideEmpty = options
            .emptyGroups == .always || (options.emptyGroups == .filtering && !options.ownerFilter.isEmpty)
        let retained = ids.filter { id in
            if buckets[id]?.isEmpty == false { return true }
            if hideEmpty || id == "pinned" || id == "work" { return false }
            return id != "groups" || returnToGroups
        }
        return retained.map { id in
            let title: String? = switch id {
            case "pinned": String(localized: "Pinned")
            case "groups": String(localized: "Groups")
            case "work": String(localized: "Coding")
            case "recent": grouping == .none || retained.allSatisfy { $0 == "recent" || $0 == "pinned" }
                ? nil : String(localized: "Other")
            default: titles[id] ?? String(id.dropFirst(6))
            }
            let nodes = buckets[id] ?? []
            let nodesByKey = Dictionary(
                nodes.map { (identity($0.session), $0) },
                uniquingKeysWith: { first, _ in first })
            return Section(
                id: id,
                title: title,
                nodes: id == "pinned"
                    ? OpenClawChatSessionListOrganizer.organize(nodes.map(\.session))
                    .compactMap { nodesByKey[identity($0)] } : nodes)
        }
    }

    static func nodes(_ nodes: [Node], matchingOwner ownerID: String?) -> [Node] {
        guard let ownerID else { return nodes }
        // Keep canonical descendants for summaries; filter only the navigation projection.
        return nodes.flatMap { node in
            node.session.owner?.actor.id == ownerID ? [node] : self.nodes(node.children, matchingOwner: ownerID)
        }
    }

    private static func orderedZones(_ stored: [String], categories: [String]) -> [String] {
        // ui/src/lib/sessions/grouping.ts:72: new categories precede built-ins; missing built-ins follow their predecessor.
        let builtIns = ["recent", "groups", "work"]
        let groupIDs = categories.map { "group:\($0)" }
        var order: [String] = []
        for raw in stored {
            let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let id = token == "ungrouped" ? "recent" : token.hasPrefix("category:")
                ? "group:" + token.dropFirst(9).trimmingCharacters(in: .whitespacesAndNewlines) : token
            if builtIns.contains(id) || groupIDs.contains(id), !order.contains(id) { order.append(id) }
        }
        for id in groupIDs where !order.contains(id) {
            order.insert(id, at: order.firstIndex(where: builtIns.contains) ?? order.endIndex)
        }
        for (index, id) in builtIns.enumerated() where !order.contains(id) {
            let predecessor = index > 0 ? order.firstIndex(of: builtIns[index - 1]) : nil
            order.insert(id, at: predecessor.map { $0 + 1 } ?? order.endIndex)
        }
        return order
    }

    private static func isCodingSessionKey(_ key: String) -> Bool {
        // ui/src/lib/sessions/session-key.ts:40,430 folds empty display segments before checking agent ACP prefixes.
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key.hasPrefix("acp:") { return true }
        let parts = key.split(separator: ":")
        guard parts.count >= 3, parts[0] == "agent",
              !parts[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return parts.dropFirst(2).joined(separator: ":").trimmingCharacters(in: .whitespacesAndNewlines)
            .hasPrefix("acp:")
    }

    static func projectPath(_ row: OpenClawChatSessionEntry) -> String? {
        // ui/src/lib/session-display.ts:91 and sessions/catalog-project-grouping.ts:32 share repo/worktree identity.
        let repository = (row.repository?["url"]?.value as? String).map {
            $0.hasSuffix(".git") ? String($0.dropLast(4)) : $0
        }
        let path = ChatPayloadDecoding.trimmedNonEmptyString(repository) ??
            (row.execNode == nil ? ChatPayloadDecoding.trimmedNonEmptyString(row.worktree?.repoRoot) : nil) ??
            (row.execNode != nil ? ChatPayloadDecoding.trimmedNonEmptyString(row.execCwd) :
                ChatPayloadDecoding.trimmedNonEmptyString(row.spawnedWorkspaceDir) ??
                ChatPayloadDecoding.trimmedNonEmptyString(row.spawnedCwd))
        guard var path else { return nil }
        path = path.replacingOccurrences(of: #"[\\/]+$"#, with: "", options: .regularExpression)
        if let range = path.range(of: #"[\\/]\.claude[\\/]worktrees[\\/][^\\/]"#, options: .regularExpression) {
            path = String(path[..<range.lowerBound])
        }
        return path.isEmpty ? nil : path
    }

    static func identityField(_ identity: AnyCodable, _ field: String) -> String? {
        (identity.value as? [String: AnyCodable])?[field]?.value as? String
    }

    static func identityKey(_ identity: AnyCodable) -> String {
        if let type = self.identityField(identity, "type"), ["profile", "agent"].contains(type),
           let id = self.identityField(identity, "id") { return "\(type):\(id)" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(identity)).flatMap { String(bytes: $0, encoding: .utf8) } ?? ""
    }
}
