import Foundation
import OpenClawProtocol

/// Pure grouping/filtering shared by the Apple sessions sidebars. Kept UI-free
/// so pin/search/ordering rules stay unit-testable across macOS and iOS.
public enum ChatSessionSidebarModel {
    enum ActivityKind: Equatable, Sendable {
        case attention, running, queued, failed, finished, idle, unknown
    }

    struct Activity: Equatable, Sendable {
        let kind: ActivityKind
        let text: String

        var symbol: String {
            switch self.kind {
            case .attention: "hand.raised.fill"
            case .running: "circle.dotted"
            case .queued: "clock"
            case .failed: "exclamationmark.triangle.fill"
            case .finished: "checkmark"
            case .idle: "minus"
            case .unknown: "text.bubble"
            }
        }
    }

    struct AgentSummary: Equatable, Sendable {
        let runningCount: Int
        let queuedCount: Int
        let attentionCount: Int
        let unreadCount: Int
        let activity: Activity?
    }

    static func activity(
        for session: OpenClawChatSessionEntry,
        now: Double = Date().timeIntervalSince1970 * 1000) -> Activity?
    {
        let declared = self.activeAgentStatus(session.agentStatus, now: now)
        let observer = self.visibleObserverDigest(for: session)
        let status = ChatPayloadDecoding.trimmedNonEmptyString(session.status)?.lowercased()
        if let declared, ChatPayloadDecoding.trimmedNonEmptyString(declared.attention) != nil {
            return Activity(kind: .attention, text: declared.note)
        }
        if let observer, ["waiting-on-user", "stuck"].contains(observer.health.lowercased()) {
            return Activity(kind: .attention, text: observer.headline)
        }
        if let failure = self.unreadFailureReason(for: session) {
            return Activity(kind: .failed, text: failure)
        }
        if status == "queued" {
            return Activity(kind: .queued, text: declared?.note ?? String(localized: "Queued"))
        }
        if self.isRunning(session) || session.hasActiveSubagentRun == true {
            let liveHeadline = self.isRunning(session) ? observer?.headline : nil
            return Activity(kind: .running, text: declared?.note ?? liveHeadline ?? String(localized: "Working"))
        }
        if status == "failed" || status == "timeout" || observer?.health.lowercased() == "failed" {
            return Activity(kind: .failed, text: observer?.headline ?? String(localized: "Failed"))
        }
        if status == "done" || status == "completed" || observer?.health.lowercased() == "done" {
            return Activity(kind: .finished, text: observer?.headline ?? String(localized: "Finished"))
        }
        if status == "idle" { return Activity(kind: .idle, text: String(localized: "Idle")) }
        return declared.map { Activity(kind: .unknown, text: $0.note) }
    }

    static func agentSummary(
        for agentID: String,
        sessions: [OpenClawChatSessionEntry],
        now: Double = Date().timeIntervalSince1970 * 1000) -> AgentSummary?
    {
        var seen = Set<String>()
        let owned = sessions.filter { entry in
            let owner = ChatPayloadDecoding.trimmedNonEmptyString(entry.agentId) ?? OpenClawChatSessionKey
                .agentID(from: entry.key)
            return owner?.lowercased() == agentID.lowercased() && !entry.isArchived &&
                !self.isHiddenInternalSession(entry.key) &&
                self.isSessionInActiveAgentScope(key: entry.key, agentID: entry.agentId, activeAgentID: agentID) &&
                seen.insert(entry.key).inserted
        }
        guard !owned.isEmpty else { return nil }
        let states = owned.map { ($0, self.activity(for: $0, now: now)) }
        let attention = states.filter { entry, activity in
            activity?.kind == .attention || (activity?.kind == .failed &&
                (entry.unread == true || (entry.lastReadAt ?? 0) < (entry.endedAt ?? entry.updatedAt ?? 0)))
        }
        let working = states.filter { $0.1?.kind == .running || $0.1?.kind == .queued }
        let informative = states.filter { _, activity in
            guard let activity else { return false }
            if activity.kind == .failed { return false }
            if activity.kind == .idle { return false }
            return activity.kind != .finished || activity.text != String(localized: "Finished")
        }
        let preferred = (attention.isEmpty ? (working.isEmpty ? informative : working) : attention)
            .sorted { (self.activityTimestamp(for: $0.0) ?? 0) > (self.activityTimestamp(for: $1.0) ?? 0) }
            .compactMap(\.1).first
        return AgentSummary(
            runningCount: owned.filter { self.node(session: $0, children: []).badges.runningCount > 0 }.count,
            queuedCount: owned.filter { self.node(session: $0, children: []).badges.queuedCount > 0 }.count,
            attentionCount: attention.count,
            unreadCount: owned.filter { $0.unread == true }.count,
            activity: preferred)
    }

    static func activityTimestamp(for session: OpenClawChatSessionEntry) -> Double? {
        let timestamp = session.lastActivityAt ?? session.lastInteractionAt ?? session.updatedAt
        return timestamp.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
    }

    static func messagePreview(from messages: [OpenClawChatMessage]) -> String? {
        for message in messages.reversed() {
            let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard role == "user" || role == "assistant" else { continue }
            let text = ChatMessageVisibleText.visibleText(in: message)
                .drop(while: \.isWhitespace).prefix(512)
                .split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !text.isEmpty else { continue }
            let bounded = String(text.prefix(240))
            let plain = (try? AttributedString(
                markdown: bounded,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                .map { String($0.characters) } ?? bounded
            return role == "user" ? String(format: String(localized: "You: %@"), plain) : plain
        }
        return nil
    }

    public struct Badges: Equatable, Sendable {
        public let queuedCount: Int
        public let runningCount: Int
        public let failedCount: Int
        public let hasUnread: Bool
    }

    public struct Node: Identifiable, Equatable, Sendable {
        public let session: OpenClawChatSessionEntry
        public let children: [Node]
        public let badges: Badges
        public var foldedSessions: [OpenClawChatSessionEntry] = []
        public var loadParentKeys: [String] = []
        public var hasNavigationChildren = false

        public var id: String {
            self.session.key
        }

        public var previewSessions: [OpenClawChatSessionEntry] {
            [self.session] + self.foldedSessions + self.children.flatMap(\.previewSessions)
        }

        /// Failure text a collapsed child or folded run still owes the user, so the
        /// surviving parent row can show it (ui/src/components/app-sidebar-session-tree.ts:41).
        public var failedDescendantSummary: String? {
            ChatSessionSidebarModel.failedSessionSummary(in: self.previewSessions.dropFirst())
        }
    }

    /// The first unread failure among sessions that have no row of their own, named so
    /// the row that survives them can explain it.
    public static func failedSessionSummary(in sessions: some Sequence<OpenClawChatSessionEntry>) -> String? {
        sessions.lazy.compactMap { entry -> String? in
            guard self.isUnreadFailure(entry) else { return nil }
            let reason = ChatPayloadDecoding
                .trimmedNonEmptyString(entry.lastRunError) ?? String(localized: "Thread failed")
            let name = ChatPayloadDecoding.trimmedNonEmptyString(entry.label) ??
                ChatPayloadDecoding.trimmedNonEmptyString(entry.displayName) ?? entry.key
            return String(
                format: String(localized: "Child session %@ failed: %@"),
                name,
                reason)
        }.first
    }

    public struct Section: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String?
        public let nodes: [Node]
    }

    public static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    static func isSidebarRun(_ key: String) -> Bool {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = key.split(separator: ":")
        return key.hasPrefix("subagent:") || (parts.count >= 4 && parts[0] == "agent" && parts[2] == "subagent")
    }

    /// Matches the macOS row's failed-descendant rule
    /// (ChatSessionSidebarRowFacts.swift:70): a failure still counts until the row is read.
    static func isUnreadFailure(_ entry: OpenClawChatSessionEntry) -> Bool {
        let status = entry.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard status == "failed" || status == "timeout" else { return false }
        guard let lastReadAt = entry.lastReadAt else { return true }
        return lastReadAt < (entry.endedAt ?? entry.updatedAt ?? 0)
    }

    private static func adding(_ extra: Badges?, to badges: Badges?) -> Badges {
        let base = badges ?? Badges(queuedCount: 0, runningCount: 0, failedCount: 0, hasUnread: false)
        guard let extra else { return base }
        return Badges(
            queuedCount: base.queuedCount + extra.queuedCount,
            runningCount: base.runningCount + extra.runningCount,
            failedCount: base.failedCount + extra.failedCount,
            hasUnread: base.hasUnread || extra.hasUnread)
    }

    /// The conversation that owns a run: a forward child link first, as the section tree
    /// nests it, then the run's own backrefs, walking up through parent runs that have no
    /// row. Section folding and Home both resolve here so a run lands on one surviving row.
    private static func owningConversationKey(
        of run: OpenClawChatSessionEntry,
        ownerByChild: [String: String],
        entry: (String) -> OpenClawChatSessionEntry?) -> String?
    {
        var session = run
        for _ in 0..<16 {
            let parent = [ownerByChild[session.key], session.spawnedBy, session.parentSessionKey]
                .compactMap { ChatPayloadDecoding.trimmedNonEmptyString($0).flatMap(entry) }.first
            guard let parent else { return nil }
            if !self.isSidebarRun(parent.key) { return parent.key }
            session = parent
        }
        return nil
    }

    /// ui/src/components/app-sidebar-session-tree.ts:127 never lists a subagent run as a row:
    /// its persistent children take its place and the row that spawned it keeps its
    /// badges and attention. Pinning and groups place rows before this fold, so a run can
    /// sit in another section than its parent; its summary still belongs to the parent's
    /// row. A run with no row to own it hands over its conversations instead.
    public static func foldingSubagentRuns(_ sections: [Section]) -> [Section] {
        var nodesByKey: [String: Node] = [:]
        var ownerByChild: [String: String] = [:]

        func index(_ nodes: [Node]) {
            for node in nodes {
                if nodesByKey[node.id] == nil { nodesByKey[node.id] = node }
                for child in node.session.childSessions ?? [] where ownerByChild[child] == nil {
                    ownerByChild[child] = node.id
                }
                index(node.children)
            }
        }
        for section in sections {
            index(section.nodes)
        }

        var foldedRuns: [String: [OpenClawChatSessionEntry]] = [:]
        var addedBadges: [String: Badges] = [:]

        func rebuilding(_ node: Node, children: [Node]) -> Node {
            Node(
                session: node.session,
                children: children,
                badges: node.badges,
                foldedSessions: node.foldedSessions,
                loadParentKeys: node.loadParentKeys,
                hasNavigationChildren: node.hasNavigationChildren)
        }

        // `treeOwner` is the nearest conversation above these nodes in their section's tree.
        func folding(_ nodes: [Node], treeOwner: String?) -> [Node] {
            var kept: [Node] = []
            var pending = nodes
            while !pending.isEmpty {
                let child = pending.removeFirst()
                guard self.isSidebarRun(child.session.key) else {
                    kept.append(rebuilding(child, children: folding(child.children, treeOwner: child.id)))
                    continue
                }
                let folded = [child.session] + child.foldedSessions
                if let treeOwner {
                    // The owner's badges already count every run nested in its tree.
                    foldedRuns[treeOwner, default: []].append(contentsOf: folded)
                } else if let parent = self.owningConversationKey(
                    of: child.session,
                    ownerByChild: ownerByChild,
                    entry: { nodesByKey[$0]?.session })
                {
                    // A run left at the top of its section counted toward no row yet.
                    foldedRuns[parent, default: []].append(contentsOf: folded)
                    addedBadges[parent] = self.adding(
                        self.node(session: child.session, children: []).badges,
                        to: addedBadges[parent])
                }
                // The run's own conversations take its place in this section.
                pending.insert(contentsOf: child.children, at: 0)
            }
            return kept
        }

        func applying(_ node: Node) -> Node {
            let children = node.children.map(applying)
            guard let runs = foldedRuns[node.id] else { return rebuilding(node, children: children) }
            return Node(
                session: node.session,
                children: children,
                badges: addedBadges[node.id].map { self.adding($0, to: node.badges) } ?? node.badges,
                foldedSessions: node.foldedSessions + runs,
                loadParentKeys: node.loadParentKeys,
                hasNavigationChildren: node.hasNavigationChildren)
        }

        let rebuilt = sections.map {
            Section(id: $0.id, title: $0.title, nodes: folding($0.nodes, treeOwner: nil))
        }
        return rebuilt.compactMap { section -> Section? in
            let nodes = section.nodes.map(applying)
            return nodes.isEmpty ? nil : Section(id: section.id, title: section.title, nodes: nodes)
        }
    }

    /// Runs that fold into a row the sidebar itself never lists, such as Home.
    /// Home is navigation, so its runs belong on that row the way the Control UI
    /// keeps Home's run summary on the agent header
    /// (ui/src/components/app-sidebar-agent-session-rows.ts:310). A run under a
    /// listed child folds there instead.
    public static func foldedRuns(
        in sessions: [OpenClawChatSessionEntry],
        under parentKey: String) -> [OpenClawChatSessionEntry]
    {
        let rowsByKey = Dictionary(sessions.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var ownerByChild: [String: String] = [:]
        for parent in sessions {
            for child in parent.childSessions ?? [] where ownerByChild[child] == nil {
                ownerByChild[child] = parent.key
            }
        }
        return sessions.filter { session in
            self.isSidebarRun(session.key) && self.owningConversationKey(
                of: session,
                ownerByChild: ownerByChild,
                entry: { rowsByKey[$0] }) == parentKey
        }
    }

    static func sidebarAgentID(_ session: OpenClawChatSessionEntry) -> String? {
        OpenClawChatSessionKey.agentID(from: session.key) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.agentId)?.lowercased()
    }

    /// Omit main only when another navigation entry opens it. View options are
    /// opt-in so iOS, palettes, and other session-list consumers retain their defaults.
    @MainActor
    public static func sections(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String = "main",
        activeAgentID: String? = nil,
        groups: [OpenClawChatSessionGroup] = [],
        excludesMainSession: Bool = false,
        query: String,
        rankedSearch: Bool = false,
        sessionRoutingContract: String? = nil,
        viewOptions: ViewOptions? = nil,
        observedOrder: ObservedOrder = .init(),
        owners: [OpenClawChatSessionEntry.CreatedActor]? = nil,
        selfOwnerID: String? = nil,
        sectionOrder: [String] = [],
        supplementalSessions: [OpenClawChatSessionEntry] = [],
        lineageRootKey: String? = nil,
        childMembership: [String: [String]] = [:],
        allowedAgentIDs: Set<String>? = nil,
        now: Date = .now) -> [Section]
    {
        let identity: (OpenClawChatSessionEntry) -> String = { row in
            viewOptions == nil ? row.key : OpenClawChatSessionSidebarData.identity(row)
        }
        let (availableEntries, resolvedMainSessionKey) = self.visibleSessions(
            roster: (sessions, supplementalSessions),
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            excludesMainSession: excludesMainSession,
            sessionRoutingContract: sessionRoutingContract,
            visibility: (viewOptions, now))
        // app-sidebar-agent-session-rows.ts:71 filters selectable roots before both Pages and agent sections.
        let entries = allowedAgentIDs.map { agents in
            availableEntries.filter { Self.sidebarAgentID($0).map(agents.contains) == true }
        } ?? availableEntries
        if rankedSearch {
            // Apply sidebar visibility before the palette's ten-result cap, preserving incoming relevance order.
            // ui/src/components/command-palette-session-search.ts:63.
            let visible = Set(entries.map(OpenClawChatSessionSidebarData.identity))
            let nodes = sessions.filter { visible.contains(OpenClawChatSessionSidebarData.identity($0)) }
                .prefix(10).flatMap { self.tree(from: [$0], identity: identity) }
            return nodes.isEmpty ? [] : [.init(id: "search", title: String(localized: "Search results"), nodes: nodes)]
        }
        let ordered: [OpenClawChatSessionEntry]
        let sort = viewOptions?.sort == .people && owners.map { $0.count < 2 } == true ? .created : viewOptions?.sort
        if sort == .created || sort == .people {
            var order = observedOrder
            order.observe(sessions.map(identity))
            ordered = order.sortedByCreation(entries, owners: sort == .people ? owners ?? [] : nil, identity: identity)
        } else {
            ordered = OpenClawChatSessionListOrganizer.organize(entries)
        }
        let visible = OpenClawChatSessionListOrganizer.filter(ordered, search: query)
        if let viewOptions {
            #if os(macOS)
            var mainKeys: Set<String> = [mainSessionKey, resolvedMainSessionKey]
            if activeAgentID == nil {
                // ui/src/components/app-sidebar-agent-session-rows.ts:123 omits every agent's Home in roster mode.
                let main = OpenClawChatSessionRoutingContract.parse(sessionRoutingContract)?.mainKey ??
                    String(mainSessionKey.split(separator: ":", maxSplits: 2).last ?? "main")
                let agents = allowedAgentIDs ?? Set((sessions + supplementalSessions).compactMap(Self.sidebarAgentID))
                mainKeys.formUnion(agents.map { ChatSessionNavigation.primaryKey(agentID: $0, mainKey: main) })
            }
            let nodes = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? self.sidebarTree(
                roots: visible,
                rows: sessions + supplementalSessions,
                home: (keys: mainKeys, excluded: excludesMainSession),
                selectedKey: currentSessionKey,
                lineageRootKey: lineageRootKey,
                membership: childMembership,
                options: viewOptions,
                allowedAgentIDs: allowedAgentIDs,
                now: now) : visible.flatMap { self.tree(from: [$0], identity: identity) }
            let byKey = Dictionary(nodes.map { (identity($0.session), $0) }, uniquingKeysWith: { first, _ in first })
            let groupRows = nodes.map { node in
                var row = node.session
                row.childSessions = nil // Group projected roots without rebuilding their child links.
                return row
            }
            #else
            let groupRows = visible
            #endif
            let sections = self.groupedSections(
                groupRows,
                groups: groups,
                options: viewOptions,
                peopleAvailable: owners.map { $0.count >= 2 } ?? true,
                selfOwnerID: selfOwnerID,
                sectionOrder: sectionOrder,
                identity: identity)
            #if os(macOS)
            return sections.map {
                Section(id: $0.id, title: $0.title, nodes: $0.nodes.compactMap { byKey[identity($0.session)] })
            }
            #else
            return sections
            #endif
        }
        // Pin state owns first placement. Group sections then preserve the
        // same tree builder, so grouped parent/child rosters still nest.
        let pinned = self.tree(
            from: OpenClawChatSessionListOrganizer.organize(visible.filter { $0.pinned == true }),
            identity: identity)
        let unpinned = visible.filter { $0.pinned != true }
        let orderedGroups = groups.sorted { lhs, rhs in
            lhs.position == rhs.position ? lhs.name < rhs.name : lhs.position < rhs.position
        }
        let groupNames = Set(orderedGroups.map(\.name))
        let recent = self.tree(from: unpinned.filter { session in
            guard let category = session.category else { return true }
            return !groupNames.contains(category)
        }, identity: identity)

        var result: [Section] = []
        if !pinned.isEmpty {
            result.append(Section(id: "pinned", title: "Pinned", nodes: pinned))
        }
        for group in orderedGroups {
            let nodes = self.tree(
                from: unpinned.filter { $0.category == group.name }, identity: identity)
            if !nodes.isEmpty {
                result.append(Section(id: "group:\(group.name)", title: group.name, nodes: nodes))
            }
        }
        if !recent.isEmpty {
            result.append(Section(
                id: "recent",
                title: result.isEmpty ? nil : "Recent",
                nodes: recent))
        }
        return result
    }

    static func tree(
        from sessions: [OpenClawChatSessionEntry],
        identity: (OpenClawChatSessionEntry) -> String = { $0.key }) -> [Node]
    {
        let hierarchyPresent = sessions.contains { session in
            ChatPayloadDecoding.trimmedNonEmptyString(session.spawnedBy) != nil ||
                ChatPayloadDecoding.trimmedNonEmptyString(session.parentSessionKey) != nil ||
                session.childSessions != nil
        }
        guard hierarchyPresent else {
            return sessions.map { self.node(session: $0, children: []) }
        }

        let sessionKeys = Set(sessions.map(identity))
        var parentByChild: [String: String] = [:]
        // The gateway child roster is freshness-filtered and omitted when
        // empty. Persisted parent metadata can outlive that freshness window,
        // so it is display metadata only and must not recreate stale edges.
        for parent in sessions {
            for childKey in parent.childSessions ?? [] where childKey != parent.key {
                // ui/src/lib/sessions/session-pending-rows.ts:95 keeps bare keys tied to their owner.
                var child = parent
                child.key = childKey
                child.agentId = OpenClawChatSessionKey.agentID(from: parent.key) ?? parent.agentId
                let childID = identity(child)
                if sessionKeys.contains(childID), parentByChild[childID] == nil {
                    parentByChild[childID] = identity(parent)
                }
            }
        }

        var orderByKey: [String: Int] = [:]
        for (offset, session) in sessions.enumerated() where orderByKey[identity(session)] == nil {
            orderByKey[identity(session)] = offset
        }
        for session in sessions {
            var path: [String] = []
            var indexByKey: [String: Int] = [:]
            var cursor: String? = identity(session)
            while let current = cursor, let parent = parentByChild[current] {
                indexByKey[current] = path.count
                path.append(current)
                if let cycleStart = indexByKey[parent] {
                    let cycle = path[cycleStart...]
                    let root = cycle.min { (orderByKey[$0] ?? Int.max) < (orderByKey[$1] ?? Int.max) }
                    if let root {
                        parentByChild[root] = nil
                    }
                    break
                }
                cursor = parent
            }
        }

        var childrenByParent: [String: [OpenClawChatSessionEntry]] = [:]
        for session in sessions {
            if let parentKey = parentByChild[identity(session)] {
                childrenByParent[parentKey, default: []].append(session)
            }
        }

        func build(_ session: OpenClawChatSessionEntry) -> Node {
            Self.node(session: session, children: (childrenByParent[identity(session)] ?? []).map(build))
        }

        return sessions.compactMap { session in
            guard parentByChild[identity(session)] == nil else { return nil }
            return build(session)
        }
    }

    private static func node(session: OpenClawChatSessionEntry, children: [Node]) -> Node {
        let status = session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let isQueued = status == "queued"
        let isRunning = !isQueued &&
            (session.hasActiveRun == true || session.hasActiveSubagentRun == true || status == "running")
        let hasFailed = status == "failed" || status == "timeout"
        return Node(
            session: session,
            children: children,
            badges: Badges(
                queuedCount: (isQueued ? 1 : 0) + children.reduce(0) { $0 + $1.badges.queuedCount },
                runningCount: (isRunning ? 1 : 0) + children.reduce(0) { $0 + $1.badges.runningCount },
                failedCount: (hasFailed ? 1 : 0) + children.reduce(0) { $0 + $1.badges.failedCount },
                hasUnread: session.unread == true || children.contains { $0.badges.hasUnread }))
    }

    /// Resolves the single session-list subtitle slot with the same ownership
    /// order as the web sidebar. Gateway-supplied text stays verbatim.
    public static func subtitle(
        for session: OpenClawChatSessionEntry,
        workSubtitle: String?,
        now: Double = Date().timeIntervalSince1970 * 1000) -> String?
    {
        let agentStatus = self.activeAgentStatus(session.agentStatus, now: now)
        let declaredAttention = agentStatus?.attention == nil ? nil : agentStatus?.note
        let failedAttention = self.unreadFailureReason(for: session)
        let statusNote = agentStatus?.note
        let queued = ChatPayloadDecoding.trimmedNonEmptyString(session.status)?.lowercased() == "queued"
            ? String(localized: "Waiting for a concurrency slot")
            : nil
        let observer = self.visibleObserverDigest(for: session)?.headline
        return declaredAttention ?? failedAttention ?? statusNote ?? queued ?? observer ?? workSubtitle
    }

    /// Live observer events are useful only after a server row names the
    /// active run. This prevents a late event from a prior run taking over a
    /// replacement run that reused the same session key.
    public static func applying(
        observerDigest digest: SessionObserverDigest,
        to sessions: [OpenClawChatSessionEntry],
        activeAgentId: String? = nil) -> [OpenClawChatSessionEntry]
    {
        let scopedSessions = self.clearingForeignGlobalObserverDigest(
            in: sessions,
            activeAgentId: activeAgentId)
        guard self.sessionMatchesActiveAgent(
            sessionKey: digest.sessionkey,
            agentId: digest.agentid,
            activeAgentId: activeAgentId)
        else { return scopedSessions }
        guard let index = scopedSessions.firstIndex(where: { $0.key == digest.sessionkey }) else {
            return scopedSessions
        }
        var session = scopedSessions[index]
        let candidate = OpenClawChatSessionObserverDigest(digest)
        let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
        guard self.isRunning(session),
              let runId = ChatPayloadDecoding.trimmedNonEmptyString(candidate.runId),
              activeRunIds.contains(runId)
        else { return scopedSessions }

        if let previous = session.observerDigest,
           previous.runId == candidate.runId,
           !self.isNewer(candidate, than: previous)
        {
            return scopedSessions
        }

        session.observerDigest = candidate
        var updated = scopedSessions
        updated[index] = session
        return updated
    }

    public static func reconcilingGlobalObserverDigestOwner(
        in sessions: [OpenClawChatSessionEntry],
        activeAgentId: String?) -> [OpenClawChatSessionEntry]
    {
        self.reconcilingGlobalObserverDigestOwner(
            in: sessions,
            activeAgentId: activeAgentId,
            adoptOwnerless: true)
    }

    public static func clearingForeignGlobalObserverDigest(
        in sessions: [OpenClawChatSessionEntry],
        activeAgentId: String?) -> [OpenClawChatSessionEntry]
    {
        self.reconcilingGlobalObserverDigestOwner(
            in: sessions,
            activeAgentId: activeAgentId,
            adoptOwnerless: false)
    }

    static func sessionMatchesActiveAgent(
        sessionKey: String?,
        agentId: String?,
        activeAgentId: String?) -> Bool
    {
        guard ChatPayloadDecoding.trimmedNonEmptyString(sessionKey)?.lowercased() == "global" else { return true }
        guard let owner = ChatPayloadDecoding.trimmedNonEmptyString(agentId)?.lowercased() else { return false }
        return owner == ChatPayloadDecoding.trimmedNonEmptyString(activeAgentId)?.lowercased()
    }

    private static func reconcilingGlobalObserverDigestOwner(
        in sessions: [OpenClawChatSessionEntry],
        activeAgentId: String?,
        adoptOwnerless: Bool) -> [OpenClawChatSessionEntry]
    {
        // Missing ownership is transient disconnect state, not an agent switch.
        // Preserve the last verified offline projection until routing identity returns.
        guard let selectedAgentId = ChatPayloadDecoding.trimmedNonEmptyString(activeAgentId)?.lowercased(),
              let index = sessions.firstIndex(where: { $0.key == "global" }),
              let digest = sessions[index].observerDigest
        else { return sessions }
        let digestAgentId = ChatPayloadDecoding.trimmedNonEmptyString(digest.agentId)?.lowercased()
        guard digestAgentId != selectedAgentId else { return sessions }
        var updated = sessions
        updated[index].observerDigest = if digestAgentId == nil, adoptOwnerless {
            OpenClawChatSessionObserverDigest(
                agentId: selectedAgentId,
                runId: digest.runId,
                revision: digest.revision,
                updatedAt: digest.updatedAt,
                headline: digest.headline,
                health: digest.health)
        } else {
            nil
        }
        return updated
    }

    private static func observerProjection(
        for change: OpenClawChatSessionsChangedEvent,
        activeAgentId: String?) -> (digest: OpenClawChatSessionObserverDigest?, present: Bool)?
    {
        let digest = change.observerDigest
        let present = change.observerDigestPresent
        guard ChatPayloadDecoding.trimmedNonEmptyString(change.sessionKey)?.lowercased() == "global" else {
            return (digest, present)
        }
        guard self.sessionMatchesActiveAgent(
            sessionKey: change.sessionKey,
            agentId: change.agentId,
            activeAgentId: activeAgentId),
            let owner = ChatPayloadDecoding.trimmedNonEmptyString(change.agentId)?.lowercased()
        else { return nil }
        guard let digest else { return (nil, present) }
        let digestOwner = ChatPayloadDecoding.trimmedNonEmptyString(digest.agentId)?.lowercased()
        if digestOwner == nil {
            return (
                OpenClawChatSessionObserverDigest(
                    agentId: owner,
                    runId: digest.runId,
                    revision: digest.revision,
                    updatedAt: digest.updatedAt,
                    headline: digest.headline,
                    health: digest.health),
                present)
        }
        return digestOwner == owner ? (digest, present) : (nil, false)
    }

    /// Session snapshots own rollover and clearing. A projected digest may
    /// advance a live one, while an active-run change immediately retires any
    /// digest that no longer belongs to a server-reported run.
    public static func applying(
        sessionChange change: OpenClawChatSessionsChangedEvent,
        to sessions: [OpenClawChatSessionEntry],
        activeAgentId: String? = nil) -> [OpenClawChatSessionEntry]?
    {
        guard let key = change.sessionKey ?? change.session?.key else { return sessions }
        guard let index = sessions.firstIndex(where: { $0.key == key }) else { return nil }
        guard let projection = self.observerProjection(for: change, activeAgentId: activeAgentId)
        else { return sessions }

        guard var session = self.sessionSnapshot(for: change, previous: sessions[index]) else { return nil }
        if let updatedAt = change.updatedAt {
            session.updatedAt = updatedAt
        }
        if let lastReadAt = change.lastReadAt {
            session.lastReadAt = lastReadAt
        }
        if change.colorPresent {
            session.color = change.color
        }
        if change.agentStatusPresent {
            session.agentStatus = change.agentStatus
        }
        if change.statusPresent {
            session.status = change.status
        }
        if change.lastRunErrorPresent {
            session.lastRunError = change.lastRunError
        }
        if let hasActiveRun = change.hasActiveRun {
            session.hasActiveRun = hasActiveRun
        }
        if change.activeRunIdsPresent {
            session.activeRunIds = change.activeRunIds
        }
        if let reasoningLevel = change.session?.reasoningLevel {
            session.reasoningLevel = reasoningLevel
        }
        if let startedAt = change.startedAt {
            session.startedAt = startedAt
        }
        if let endedAt = change.endedAt {
            session.endedAt = endedAt
        }

        let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
        if self.isRunning(session),
           ChatPayloadDecoding.trimmedNonEmptyString(session.observerDigest?.runId).map(activeRunIds.contains) != true
        {
            session.observerDigest = nil
        }
        if projection.present {
            if let projected = projection.digest {
                let matchesActiveRun = !self.isRunning(session) ||
                    ChatPayloadDecoding.trimmedNonEmptyString(projected.runId).map(activeRunIds.contains) == true
                let supersedesPrevious = session.observerDigest.map {
                    $0.runId != projected.runId || self.isNewer(projected, than: $0)
                } ?? true
                if matchesActiveRun, supersedesPrevious {
                    session.observerDigest = projected
                }
            } else {
                session.observerDigest = nil
            }
        }

        var updated = sessions
        updated[index] = session
        return self.clearingForeignGlobalObserverDigest(in: updated, activeAgentId: activeAgentId)
    }

    private static func sessionSnapshot(
        for change: OpenClawChatSessionsChangedEvent,
        previous: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry?
    {
        guard let row = change.session else { return previous }
        guard row.key == previous.key else { return nil }
        guard row.sessionId != nil, row.kind != nil else { return previous }
        if row.sessionId == previous.sessionId, let offeredDate = row.updatedAt,
           let heldDate = previous.updatedAt, offeredDate < heldDate { return nil }
        let sessionFields = change.sessionFields
        var session = if row.sessionId == previous.sessionId, let sessionFields {
            self.mergingSessionFields(row, fields: sessionFields, into: previous)
        } else {
            row
        }
        if session.sessionId == previous.sessionId, self.isRunning(session),
           let digest = previous.observerDigest,
           self.sessionMatchesActiveAgent(
               sessionKey: row.key,
               agentId: digest.agentId ?? previous.agentId,
               activeAgentId: change.agentId ?? row.agentId),
           digest.runId.map(self.normalizedActiveRunIds(session.activeRunIds).contains) == true,
           session.observerDigest.map({ self.isNewer(digest, than: $0) }) ?? true
        {
            session.observerDigest = digest
        }
        return session
    }

    private static func visibleObserverDigest(
        for session: OpenClawChatSessionEntry) -> OpenClawChatSessionObserverDigest?
    {
        guard let digest = session.observerDigest else { return nil }
        if self.isRunning(session) {
            let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
            guard let runId = ChatPayloadDecoding.trimmedNonEmptyString(digest.runId),
                  activeRunIds.contains(runId)
            else { return nil }
            return digest
        }
        let health = digest.health.lowercased()
        guard health == "done" || health == "failed",
              (session.lastReadAt ?? 0) < digest.updatedAt
        else { return nil }
        return digest
    }

    static func activeAgentStatus(
        _ status: OpenClawChatSessionAgentStatus?,
        now: Double) -> OpenClawChatSessionAgentStatus?
    {
        guard let status,
              status.expiresAt > now,
              !status.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return status
    }

    private static func unreadFailureReason(for session: OpenClawChatSessionEntry) -> String? {
        let status = session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard status == "failed" || status == "timeout" else { return nil }
        let failureAt = session.endedAt ?? session.updatedAt ?? 0
        guard (session.lastReadAt ?? 0) < failureAt else { return nil }
        return ChatPayloadDecoding.trimmedNonEmptyString(session.lastRunError)
    }

    static func isRunning(_ session: OpenClawChatSessionEntry) -> Bool {
        session.hasActiveRun == true ||
            session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "running"
    }

    static func isNewer(
        _ candidate: OpenClawChatSessionObserverDigest,
        than previous: OpenClawChatSessionObserverDigest) -> Bool
    {
        candidate.revision > previous.revision ||
            (candidate.revision == previous.revision && candidate.updatedAt > previous.updatedAt)
    }

    private static func normalizedActiveRunIds(_ runIds: [String]?) -> Set<String> {
        Set((runIds ?? []).compactMap(ChatPayloadDecoding.trimmedNonEmptyString))
    }

    public static func canDeleteSession(key: String, mainSessionKey: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedMain = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized != "main" && normalized != "global" && normalized != normalizedMain
    }

    public static func canArchiveSession(
        _ session: OpenClawChatSessionEntry,
        mainSessionKey: String) -> Bool
    {
        ChatPayloadDecoding.trimmedNonEmptyString(session.sessionId) != nil &&
            self.canDeleteSession(key: session.key, mainSessionKey: mainSessionKey) &&
            !self.isRunning(session) && session.hasActiveSubagentRun != true
    }

    public static func isSessionInActiveAgentScope(
        key: String,
        agentID: String? = nil,
        activeAgentID: String?) -> Bool
    {
        let normalizedAgent = activeAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalizedAgent.isEmpty else { return true }
        // Gateway row ownership outranks ambiguous bare/global keys. Missing
        // metadata is a shipped legacy-cache state and keeps key-only behavior.
        let rowAgent = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let rowAgent, !rowAgent.isEmpty, rowAgent != normalizedAgent { return false }
        let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].lowercased() == "agent" else { return true }
        return parts[1].lowercased() == normalizedAgent
    }

    @MainActor
    public static func selectedSessionKey(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        sessionRoutingContract: String? = nil) -> String
    {
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // The stored global row is distinct from an ordinary owner-qualified :global conversation.
        if normalizedCurrent == "global" { return currentSessionKey }
        let preferredAliasKey = if normalizedCurrent == "main" {
            mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        } else {
            ""
        }
        // The selected wrapper is the active session even when archived;
        // active rows stay visible until the user leaves them.
        if let preferred = sessions.first(where: { $0.key.lowercased() == preferredAliasKey }) {
            return preferred.key
        }
        if sessions.contains(where: { $0.key == currentSessionKey }) {
            return currentSessionKey
        }
        return sessions.first(where: {
            OpenClawChatViewModel.matchesCurrentSessionKey(
                incoming: $0.key,
                agentId: $0.agentId,
                current: currentSessionKey,
                mainSessionKey: mainSessionKey,
                activeAgentId: activeAgentID,
                sessionRoutingContract: sessionRoutingContract)
        })?.key ?? currentSessionKey
    }

    @MainActor
    private static func visibleSessions(
        roster: (rows: [OpenClawChatSessionEntry], supplemental: [OpenClawChatSessionEntry]),
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        excludesMainSession: Bool,
        sessionRoutingContract: String?,
        visibility: (options: ViewOptions?, now: Date)) -> ([OpenClawChatSessionEntry], String)
    {
        let (viewOptions, now) = visibility
        let scopedSessions = roster.rows.filter {
            self.isSessionInActiveAgentScope(key: $0.key, agentID: $0.agentId, activeAgentID: activeAgentID)
        }
        let knownSessions = scopedSessions + roster.supplemental.filter {
            self.isSessionInActiveAgentScope(key: $0.key, agentID: $0.agentId, activeAgentID: activeAgentID)
        }
        // ui/src/lib/sessions/session-key.ts:273 compares the selected owner independently of list scope.
        let selectedAgentID = viewOptions?.selectedAgentID ??
            OpenClawChatSessionKey.agentID(from: currentSessionKey) ?? activeAgentID
        let selectionRows = viewOptions == nil ? knownSessions : knownSessions.filter {
            self.isSessionInActiveAgentScope(key: $0.key, agentID: $0.agentId, activeAgentID: selectedAgentID)
        }
        let selectedSessionKey = self.selectedSessionKey(
            sessions: selectionRows,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: viewOptions == nil ? activeAgentID : selectedAgentID,
            sessionRoutingContract: sessionRoutingContract)
        let resolvedMainSessionKey = self.selectedSessionKey(
            sessions: selectionRows,
            currentSessionKey: "main",
            mainSessionKey: mainSessionKey,
            activeAgentID: viewOptions == nil ? activeAgentID : selectedAgentID,
            sessionRoutingContract: sessionRoutingContract)
        func isSelectedOwner(_ entry: OpenClawChatSessionEntry) -> Bool {
            viewOptions == nil || self.isSessionInActiveAgentScope(
                key: entry.key, agentID: entry.agentId, activeAgentID: selectedAgentID)
        }
        func isSelected(_ entry: OpenClawChatSessionEntry) -> Bool {
            // A local model update may precede owner discovery; retain its exact unresolved identity.
            entry.key == selectedSessionKey && (viewOptions == nil ||
                (selectedAgentID == nil && entry.agentId == nil &&
                    OpenClawChatSessionKey.agentID(from: entry.key) == nil) ||
                OpenClawChatViewModel.matchesCurrentSessionKey(
                    incoming: entry.key,
                    agentId: entry.agentId,
                    current: currentSessionKey,
                    mainSessionKey: mainSessionKey,
                    activeAgentId: selectedAgentID,
                    sessionRoutingContract: sessionRoutingContract))
        }
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let selectedIsResolvedAlias = (normalizedCurrent == "main" || normalizedCurrent == "global") &&
            selectedSessionKey.lowercased() != normalizedCurrent
        // ui/src/components/app-sidebar-agent-session-rows.ts:123 gives Home its main key before filtering.
        let selectedIsMain = if viewOptions != nil {
            OpenClawChatViewModel.matchesCurrentSessionKey(
                incoming: mainSessionKey,
                agentId: selectedAgentID,
                current: currentSessionKey,
                mainSessionKey: mainSessionKey,
                activeAgentId: selectedAgentID,
                sessionRoutingContract: sessionRoutingContract)
        } else {
            normalizedCurrent == "main" ||
                selectedSessionKey.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame
        }
        var entries = scopedSessions.filter { entry in
            if excludesMainSession,
               entry.key.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame,
               isSelectedOwner(entry)
            {
                // Home owns the main row. Removing it before tree construction
                // naturally promotes any retained child rows to section roots.
                return false
            }
            if selectedIsResolvedAlias, entry.key.lowercased() == normalizedCurrent, isSelectedOwner(entry) {
                return false
            }
            let status = viewOptions?.status ?? .active
            return (isSelected(entry) &&
                (viewOptions == nil || status.includes(entry, now: now))) ||
                (!self
                    .isHiddenInternalSession(entry.key) &&
                    (viewOptions == nil || (entry.kind != "global" && entry.kind != "unknown")) &&
                    status.includes(entry, now: now) &&
                    (viewOptions?.includes(entry) ?? true))
        }
        let selected = scopedSessions.first(where: isSelected)
        let selectedMatchesStatus = selected.map { (viewOptions?.status ?? .active).includes($0, now: now) } ?? true
        if viewOptions?.status != .archived, viewOptions?.status != .snoozed,
           viewOptions == nil || selectedMatchesStatus,
           viewOptions?.ownerFilter.isEmpty != false,
           !(excludesMainSession && selectedIsMain),
           !entries.contains(where: isSelected),
           self.isSessionInActiveAgentScope(key: selectedSessionKey, activeAgentID: activeAgentID),
           !currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            // Sessions can lag behind a fresh switch/new-session; keep the
            // active row selectable instead of showing an empty selection.
            var placeholder = OpenClawChatSessionEntry(key: selectedSessionKey)
            if viewOptions != nil { placeholder.agentId = selectedAgentID }
            entries.append(placeholder)
        }
        return (entries, resolvedMainSessionKey)
    }
}
