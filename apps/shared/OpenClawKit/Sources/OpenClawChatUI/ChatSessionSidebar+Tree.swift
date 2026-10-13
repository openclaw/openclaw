#if os(macOS)
import SwiftUI

extension ChatSessionSidebarModel {
    static func selectionTarget(
        for session: OpenClawChatSessionEntry,
        fallbackAgentID: String?) -> OpenClawChatSessionTarget
    {
        // ui/src/components/app-sidebar-session-navigation.ts:397 routes using the projected row's owner.
        .resolve(
            session.key,
            selectedAgentID: fallbackAgentID,
            overrideAgentID: sidebarAgentID(session) ?? fallbackAgentID,
            policy: .preserveBareKeys)
    }

    private static func sidebarKey(_ key: String, agentID: String?) -> String {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        // Bare sentinels share their wire key across agents; ordinary qualified keys stay distinct.
        if let agentID, ["main", "global"].contains(key.lowercased()) {
            return "\(agentID.lowercased())\u{0}\(key.lowercased())"
        }
        return self.sidebarKey(key)
    }

    static func sidebarKey(_ key: String) -> String {
        // ui/src/lib/sessions/session-key.ts:93,347 preserves opaque channel identifiers.
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.lowercased() == "main" { return "agent:main:main" }
        var parts = key.components(separatedBy: ":")
        var index = 0
        while parts.count - index >= 3, parts[index].lowercased() == "agent" {
            parts[index] = "agent"
            parts[index + 1] = parts[index + 1].lowercased()
            index += 2
        }
        while index < parts.count, parts[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            index += 1
        }
        guard index < parts.count else { return key.lowercased() }
        let channel = parts[index].lowercased()
        if channel == "catalog" { return parts.joined(separator: ":") }
        let kind = index + 1 < parts.count ? parts[index + 1].lowercased() : ""
        let matrix = channel == "matrix" && (kind == "channel" || kind == "group")
        guard matrix || (channel == "signal" && kind == "group") else { return key.lowercased() }
        parts[index] = channel
        parts[index + 1] = kind
        if matrix {
            if let thread = parts.indices.dropFirst(index + 2).dropLast()
                .last(where: { parts[$0].lowercased() == "thread" })
            {
                parts[thread] = "thread"
            }
        } else if index + 2 < parts.count {
            parts[index + 2] = parts[index + 2].trimmingCharacters(in: .whitespacesAndNewlines)
            for tail in parts.indices.dropFirst(index + 3) {
                parts[tail] = parts[tail].lowercased()
            }
        }
        return parts.joined(separator: ":")
    }

    static func isSidebarRun(_ key: String) -> Bool {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = key.split(separator: ":")
        return key.hasPrefix("subagent:") || (parts.count >= 4 && parts[0] == "agent" && parts[2] == "subagent")
    }

    static func sidebarTree(
        roots: [OpenClawChatSessionEntry],
        rows: [OpenClawChatSessionEntry],
        home: (keys: Set<String>, excluded: Bool),
        selectedKey: String,
        lineageRootKey: String?,
        membership: [String: [String]],
        options: ViewOptions,
        allowedAgentIDs: Set<String>? = nil,
        now: Date = .now) -> [Node]
    {
        let (mainKeys, excludesMain) = home
        func inScope(_ row: OpenClawChatSessionEntry) -> Bool {
            allowedAgentIDs.map { Self.sidebarAgentID(row).map($0.contains) == true } ?? true
        }
        let admittedRoots = roots.filter(inScope)
        func identity(_ row: OpenClawChatSessionEntry) -> String {
            Self.sidebarKey(row.key, agentID: Self.sidebarAgentID(row))
        }
        let mains = Set(mainKeys.map { Self.sidebarKey($0) }).union(rows.filter {
            mainKeys.contains($0.key)
        }.map(identity))
        let selectedID = Self.sidebarKey(selectedKey, agentID: options.selectedAgentID)
        // ui/src/components/app-sidebar-session-archive-visibility.ts:57: active windows cannot exclude archives.
        let membership = options.status == .active ? Dictionary(
            membership.map { (self.sidebarKey($0.key), Set($0.value.map { self.sidebarKey($0) })) },
            uniquingKeysWith: { $0.union($1) }) : [:]
        // Gateway row admission requires agent-qualified ordinary keys; child reads exclude bare sentinels.
        // ui/src/components/app-sidebar-session-navigation-logic.ts:424 uses the same canonical-key index.
        let byKey = Dictionary(rows.map { (identity($0), $0) }, uniquingKeysWith: { _, last in last })
        func independentlyPlaced(_ row: OpenClawChatSessionEntry) -> Bool {
            !Self.isSidebarRun(row.key) &&
                (row.pinned == true || ChatPayloadDecoding.trimmedNonEmptyString(row.category) != nil)
        }
        func parent(_ row: OpenClawChatSessionEntry?, listed: String? = nil) -> String? {
            let key = ChatPayloadDecoding.trimmedNonEmptyString(row?.parentSessionKey) ??
                ChatPayloadDecoding.trimmedNonEmptyString(row?.spawnedBy) ?? listed
            guard let key else { return nil }
            // ui/src/components/app-sidebar-session-parent.ts:17: Home notice links do not nest operator roots.
            if let row, row.createdVia == "operator", row.spawnDepth == 0,
               row.parentSessionId == nil, row.spawnedBy == nil, row.forkSource == nil,
               row.forkedFromParent != true, !Self.isSidebarRun(row.key), mains.contains(Self.sidebarKey(key))
            { return nil }
            let ownedKey = Self.sidebarKey(key, agentID: row.flatMap(Self.sidebarAgentID))
            // Unlisted Home reads return cross-agent children linked by the literal Gateway parent key.
            return byKey[ownedKey] == nil ? Self.sidebarKey(key) : ownedKey
        }
        let (childKeys, listedParents) = self.sidebarChildKeys(
            rows: rows, byKey: byKey, membership: membership, parent: parent)
        let rootKeys = Set(admittedRoots.map(identity))
        var reachable = rootKeys.union(excludesMain ? mains : [])
        if let lineageRootKey { reachable.insert(Self.sidebarKey(lineageRootKey)) }
        var pending = Array(reachable)
        while let key = pending.popLast() {
            guard byKey[key]?.isArchived != true else { continue }
            for child in childKeys[key] ?? [] where reachable.insert(child).inserted {
                pending.append(child)
            }
        }
        func visible(_ row: OpenClawChatSessionEntry) -> Bool {
            // app-sidebar-session-archive-visibility.ts:50 filters descendants by lifecycle, not root toggles.
            options.status.includes(row, now: now)
        }
        var promoted = Set<String>()
        pending = excludesMain ? Array(mains) : []
        var visited = Set<String>()
        while let key = pending.popLast() {
            guard visited.insert(key).inserted else { continue }
            guard byKey[key]?.isArchived != true else { continue }
            for child in childKeys[key] ?? [] {
                if Self.isSidebarRun(child) { pending.append(child) } else { promoted.insert(child) }
            }
        }
        var candidates = admittedRoots.map { byKey[identity($0)] ?? $0 }
        for row in rows where !rootKeys.contains(identity(row)) && visible(row) && inScope(row) {
            let key = identity(row)
            // ui/src/components/app-sidebar-agent-session-rows.ts:152 admits routed ancestry outside discovery toggles.
            if row.key == lineageRootKey || (options.includes(row) &&
                (promoted.contains(key) || (reachable.contains(key) && independentlyPlaced(row))))
            {
                candidates.append(row)
            }
        }
        var seen = Set<String>()
        // Web navigation keeps spawned conversations under their parent unless curated or explicitly routed.
        // ui/src/lib/sessions/navigation.ts:204; a missing parent alone does not admit an ordinary root.
        candidates = candidates.filter {
            let key = identity($0)
            return seen.insert(key).inserted && !Self.isSidebarRun(key) && !(excludesMain && mains.contains(key)) &&
                ($0.spawnedBy == nil || independentlyPlaced($0) || promoted.contains(key) ||
                    key == selectedID || $0.key == lineageRootKey)
        }
        let candidateKeys = Set(candidates.map(identity))
        var nested = Set<String>(), builtKeys = Set<String>()
        // ui/src/components/app-sidebar-session-ownership.ts:81 promotes matching children through excluded owners.
        func matchingOwner(_ node: Node) -> [Node] {
            options.ownerID == nil || node.session.owner?.actor.id == options.ownerID ? [node] : node.children
        }
        func build(_ row: OpenClawChatSessionEntry, ancestors: Set<String>) -> Node {
            var row = row
            row.agentId = row.agentId ?? Self.sidebarAgentID(row)
            let key = identity(row)
            builtKeys.insert(key)
            let ancestors = ancestors.union([key])
            let keys = row.isArchived ? [] : (childKeys[key] ?? []).filter {
                byKey[$0].map { !independentlyPlaced($0) && visible($0) } ?? (options.status != .snoozed)
            }
            let descendants = keys.compactMap { key -> Node? in
                guard !ancestors.contains(key), let child = byKey[key] else { return nil }
                return build(child, ancestors: ancestors)
            }
            // ui/src/components/app-sidebar-session-tree.ts:127 folds runs, retaining persistent descendants and reads.
            let children = descendants.flatMap { Self.isSidebarRun($0.id) ? $0.children : [$0] }
            nested.formUnion(children.map { identity($0.session) })
            let runs = descendants.filter { Self.isSidebarRun($0.id) }
            // ui/src/components/app-sidebar-session-ownership.ts:86 retains summaries when filtering navigation.
            let folded = descendants.filter {
                Self.isSidebarRun($0.id) || (options.ownerID != nil && $0.session.owner?.actor.id != options.ownerID)
            }.flatMap { [$0.session] + $0.foldedSessions }
            let running = !row.isArchived && ChatSessionSidebarRowFacts.isRunning(row)
            let queued = running && row.status == "queued"
            let childRuns = descendants.reduce(0) { $0 + $1.badges.runningCount }
            let childQueued = descendants.reduce(0) { $0 + $1.badges.queuedCount }
            // ui/src/components/app-sidebar-session-tree.ts:46,166: queued work already accounts for the run flag.
            let unloadedRun = !row.isArchived && !running && row
                .hasActiveSubagentRun == true && childRuns + childQueued == 0
            return Node(
                session: row,
                children: children.flatMap(matchingOwner),
                badges: Badges(
                    queuedCount: (queued ? 1 : 0) + childQueued,
                    runningCount: (running && !queued ? 1 : 0) + max(childRuns, unloadedRun ? 1 : 0),
                    failedCount: (["failed", "timeout"].contains(row.status ?? "") ? 1 : 0) +
                        descendants.reduce(0) { $0 + $1.badges.failedCount },
                    hasUnread: row.unread == true || descendants.contains { $0.badges.hasUnread }),
                foldedSessions: folded,
                loadParentKeys: keys.isEmpty ? [] : [row.key] + runs.flatMap(\.loadParentKeys),
                hasNavigationChildren: keys.contains { !Self.isSidebarRun($0) } || runs
                    .contains(where: \.hasNavigationChildren))
        }
        let roots = candidates.filter {
            guard !independentlyPlaced($0),
                  let key = parent($0, listed: listedParents[identity($0)]) else { return true }
            return Self.isSidebarRun(key) || !candidateKeys.contains(key)
        }
        // Keep a deterministic entry into malformed cycles instead of losing every selectable row.
        var built = roots.map { build($0, ancestors: []) }
        for row in candidates where !builtKeys.contains(identity(row)) {
            var cursor: String? = identity(row), chain = Set<String>()
            while let key = cursor, candidateKeys.contains(key), byKey[key]?.isArchived != true {
                if !chain.insert(key).inserted { built.append(build(row, ancestors: []))
                    break
                }
                cursor = parent(byKey[key], listed: listedParents[key])
            }
        }
        if let selected = candidates.first(where: { identity($0) == selectedID }),
           !builtKeys.contains(identity(selected)) { built.insert(build(selected, ancestors: []), at: 0) }
        return built.filter { node in
            guard let key = parent(node.session, listed: listedParents[identity(node.session)]),
                  Self.isSidebarRun(key) else { return true }
            return !nested.contains(identity(node.session))
        }.flatMap(matchingOwner)
    }

    private static func sidebarChildKeys(
        rows: [OpenClawChatSessionEntry],
        byKey: [String: OpenClawChatSessionEntry],
        membership: [String: Set<String>],
        parent: (OpenClawChatSessionEntry?, String?) -> String?)
        -> (children: [String: [String]], parents: [String: String])
    {
        var childKeys: [String: [String]] = [:], listedParents: [String: String] = [:]
        func append(_ child: String, to parent: String) {
            let child = Self.sidebarKey(child)
            if !childKeys[parent, default: []].contains(child) { childKeys[parent, default: []].append(child) }
            if listedParents[child] == nil { listedParents[child] = parent }
        }
        for row in rows {
            let key = Self.sidebarKey(row.key, agentID: Self.sidebarAgentID(row))
            for child in row.childSessions ?? [] {
                let child = Self.sidebarKey(child, agentID: Self.sidebarAgentID(row))
                guard byKey[child] != nil || membership[Self.sidebarKey(row.key)]?.contains(child) != false else {
                    continue
                }
                if parent(byKey[child], key) == key { append(child, to: key) }
            }
        }
        // A complete child read can retire unresolved hints, never current roster ancestry.
        // The Gateway child window is retention-filtered and may omit a known navigation child.
        for row in rows {
            if let key = parent(row, nil) {
                append(Self.sidebarKey(row.key, agentID: Self.sidebarAgentID(row)), to: key)
            }
        }
        return (childKeys, listedParents)
    }
}

enum ChatSidebarChildMode {
    case collapsed, expanded, all

    static func expansionBinding(
        modes: Binding<[String: Self]>,
        key: String,
        automaticallyExpanded: Bool) -> Binding<Bool>
    {
        // The disclosure can reread its binding before SwiftUI rebuilds the row.
        // A render-time snapshot hides the toggle, including across child hydration.
        Binding(
            get: { modes.wrappedValue[key].map { $0 != .collapsed } ?? automaticallyExpanded },
            set: { modes.wrappedValue[key] = $0 ? .expanded : .collapsed })
    }
}

extension ChatSessionSidebarModel.Node {
    @MainActor var sidebarID: String {
        OpenClawChatSessionSidebarData.identity(self.session)
    }

    func containsSelection(_ key: String, agentID: String? = nil) -> Bool {
        (ChatSessionSidebarModel.sidebarKey(self.id) == ChatSessionSidebarModel.sidebarKey(key) &&
            ChatSessionSidebarModel.isSessionInActiveAgentScope(
                key: self.id, agentID: self.session.agentId, activeAgentID: agentID)) ||
            self.children.contains { $0.containsSelection(key, agentID: agentID) }
    }

    @MainActor func visibleChildren(
        selectedKey: String,
        selectedAgentID: String? = nil,
        fullyShown: Bool,
        now: Date,
        attention: (Self) -> OpenClawChatAttentionSummary?) -> [Self]
    {
        // ui/src/components/app-sidebar-session-row-render.ts:155 caps positions, plus required branches.
        self.children.enumerated().filter { index, node in
            if fullyShown || index < 4 { return true }
            let facts = ChatSessionSidebarRowFacts(
                node: node, isChild: true, attention: attention(node), showPreview: false, preview: nil, now: now)
            let ownFailure = ["failed", "timeout"].contains(node.session.status ?? "") ? 1 : 0
            return node.containsSelection(selectedKey, agentID: selectedAgentID) || facts.running || facts
                .attentionLabel != nil ||
                node.badges.hasUnread || node.badges.failedCount > ownFailure ||
                node.previewSessions.contains { ChatSessionSidebarRowFacts.workspaceConflicts($0) > 0 }
        }.map(\.element)
    }
}

extension ChatSessionSidebar {
    @MainActor struct HydrationRequest: @MainActor Equatable {
        let scope: ChatSessionSidebarChildren.Scope?
        let generation: Int?
        let loading: Bool
        let healthy: Bool
        // ui/src/components/session-lineage-controller.ts:302: lifecycle facts, not live display updates, retire reads.
        let selection: OpenClawChatSessionEntry
        let parents: [OpenClawChatSessionEntry]
        let inlineParents: Set<String>
        let homeParents: [OpenClawChatSessionEntry]

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.scope == rhs.scope && lhs.generation == rhs.generation && lhs.loading == rhs.loading &&
                lhs.healthy == rhs.healthy && lhs.targets == rhs.targets
        }

        private var targets: [ChatSessionSidebarChildren.LineageSelection] {
            ([self.selection] + self.parents).map {
                .init(identity: ChatSessionSidebarChildren.key(for: $0), session: $0)
            }
        }
    }

    var selectedTreeSession: OpenClawChatSessionEntry {
        var row = self.viewModel.rosterEntry(key: self.viewModel.sessionKey, agentID: self.viewModel.selectedAgentID) ??
            .init(key: self.viewModel.sessionKey)
        row.agentId = row.agentId ?? self.viewModel.selectedAgentID
        return row
    }

    func homeTree(agentID: String) -> ChatSessionSidebarModel.Node? {
        let model = self.viewModel
        let owner = model.sidebarData
        let main = self.sidebarChildren.homeSession(model: model, agentID: agentID)
        var options = self.filterOptions
        options.ownerFilter = ""
        return ChatSessionSidebarModel.sidebarTree(
            roots: [main],
            rows: (self.rosterData?.rows ?? model.sessions) +
                (owner.map { self.sidebarChildren.supplementaryRows(owner: $0) } ?? []) + [main],
            home: (keys: [main.key, model.mainSessionKey(forAgent: agentID)], excluded: false),
            selectedKey: model.sessionKey,
            lineageRootKey: nil,
            membership: owner.map { self.sidebarChildren.childrenKeysByParent(owner: $0) } ?? [:],
            options: options)
            .first
    }

    func homeLoadParents(agentID: String) -> [OpenClawChatSessionEntry] {
        guard self.sessionStatus != .archived, let home = self.homeTree(agentID: agentID), !home.loadParentKeys.isEmpty
        else { return [] }
        return [home.session] + home.loadParentKeys.filter { $0 != home.id }.compactMap {
            self.viewModel.rosterEntry(key: $0, agentID: agentID)
        }
    }

    func hydrationRequest(_ sections: [ChatSessionSidebarModel.Section]) -> HydrationRequest {
        let model = self.viewModel
        let owner = model.sidebarData
        var parents: [String: OpenClawChatSessionEntry] = [:]
        var inlineParents = Set<String>()
        var homeParents: [OpenClawChatSessionEntry] = []
        func visit(_ node: ChatSessionSidebarModel.Node) {
            let expanded = self.childExpansion(node).wrappedValue
            if expanded || self.isCurrentInteractionRow(node.session) {
                for key in node.loadParentKeys {
                    if let row = owner?.row(key: key, agentID: node.session.agentId) {
                        parents[ChatSessionSidebarChildren.key(for: row)] = row
                        if expanded { inlineParents.insert(ChatSessionSidebarChildren.key(for: row)) }
                    }
                }
            }
            if expanded { node.children.forEach(visit) }
        }
        for section in sections {
            if section.id.hasPrefix("group:"), self.isGroupCollapsed(section.title ?? ""),
               self.query.isEmpty { continue }
            if let agent = model.agentChoices.first(where: { section.id == "agent:\($0.id):recent" }) {
                self.visibleAgentRows(section.nodes, agentID: agent.id).forEach(visit)
            } else { section.nodes.forEach(visit) }
        }
        if self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // app-sidebar-session-navigation.ts:302 hydrates expanded agents' Homes independently of Pages.
            let agents = self.showsAgentRoster ? model.agentChoices.map(\.id)
                .filter { !self.collapsedAgentIDs.contains($0) } :
                [model.selectedAgentID].compactMap(\.self)
            homeParents = agents.flatMap(self.homeLoadParents)
            for row in homeParents {
                parents[ChatSessionSidebarChildren.key(for: row)] = row
            }
        }
        return HydrationRequest(
            scope: owner.map(ChatSessionSidebarChildren.Scope.init),
            generation: owner?.queryState?.generation,
            loading: owner?.isLoading == true,
            healthy: model.healthOK,
            selection: self.selectedTreeSession,
            parents: parents.keys.sorted().compactMap { parents[$0] },
            inlineParents: inlineParents,
            homeParents: homeParents)
    }

    func childExpansion(_ node: ChatSessionSidebarModel.Node) -> Binding<Bool> {
        ChatSidebarChildMode.expansionBinding(
            modes: self.$childModes,
            key: node.sidebarID,
            automaticallyExpanded: node.children.contains {
                $0.containsSelection(self.viewModel.sessionKey, agentID: self.viewModel.selectedAgentID)
            })
    }

    func treeRow(
        _ node: ChatSessionSidebarModel.Node,
        isChild: Bool,
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> AnyView
    {
        let row = self.row(for: node, isChild: isChild, now: now, ownership: ownership, previewRequest: previewRequest)
        let visible = node.visibleChildren(
            selectedKey: self.viewModel.sessionKey,
            selectedAgentID: self.viewModel.selectedAgentID,
            fullyShown: self.childModes[node.sidebarID] == .all,
            now: now)
        {
            self.attentionSummary(sessions: $0.previewSessions, agentID: self.sessionAgentID($0.session), now: now)
        }
        return AnyView(Group {
            if node.hasNavigationChildren || !node.children.isEmpty {
                DisclosureGroup(isExpanded: self.childExpansion(node)) {
                    ForEach(visible, id: \.sidebarID) { child in
                        self.treeRow(
                            child,
                            isChild: true,
                            now: now,
                            ownership: ownership,
                            previewRequest: previewRequest)
                    }
                    ForEach(node.loadParentKeys, id: \.self) { key in
                        if let parent = self.viewModel.rosterEntry(key: key, agentID: node.session.agentId) {
                            self.childLoadState(parent)
                        }
                    }
                    if visible.count < node.children.count {
                        Button(String(localized: "Show more")) { self.childModes[node.sidebarID] = .all }
                            .selectionDisabled()
                    }
                } label: {
                    row
                }
                .tag(self.interactionIdentity(node.session))
            } else {
                row
            }
        })
    }

    @ViewBuilder func childLoadState(_ row: OpenClawChatSessionEntry) -> some View {
        let id = ChatSessionSidebarChildren.key(for: row)
        if self.sidebarChildren.loading.contains(id) { ProgressView().controlSize(.small) }
        if let error = self.sidebarChildren.errors[id] ??
            (id == ChatSessionSidebarChildren.key(for: self.selectedTreeSession) ? self.sidebarChildren
                .lineageError : nil)
        {
            Text(verbatim: error).foregroundStyle(.secondary)
            Button(String(localized: "Retry")) { Task { await self.sidebarChildren.retry(
                parent: row,
                model: self.viewModel) } }
                .disabled(self.rosterData?.isLoading == true)
                .selectionDisabled()
        }
    }
}
#endif
