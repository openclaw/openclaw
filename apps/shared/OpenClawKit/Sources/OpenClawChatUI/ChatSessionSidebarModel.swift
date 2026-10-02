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

        public var id: String {
            self.session.key
        }
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
        now: Date = .now) -> [Section]
    {
        let entries = self.visibleSessions(
            sessions: sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            excludesMainSession: excludesMainSession,
            sessionRoutingContract: sessionRoutingContract,
            visibility: (viewOptions, now))
        if rankedSearch {
            // Apply sidebar visibility before the palette's ten-result cap, preserving incoming relevance order.
            // ui/src/components/command-palette-session-search.ts:63.
            let visible = Set(entries.map(OpenClawChatSessionSidebarData.identity))
            let nodes = sessions.filter { visible.contains(OpenClawChatSessionSidebarData.identity($0)) }
                .prefix(10).flatMap { self.tree(from: [$0]) }
            return nodes.isEmpty ? [] : [.init(id: "search", title: String(localized: "Search results"), nodes: nodes)]
        }
        let ordered: [OpenClawChatSessionEntry]
        let sort = viewOptions?.sort == .people && owners.map { $0.count < 2 } == true ? .created : viewOptions?.sort
        if sort == .created || sort == .people {
            var order = observedOrder
            order.observe(sessions.map(\.key))
            ordered = order.sortedByCreation(entries, owners: sort == .people ? owners ?? [] : nil)
        } else {
            ordered = OpenClawChatSessionListOrganizer.organize(entries)
        }
        let visible = OpenClawChatSessionListOrganizer.filter(ordered, search: query)
        if let viewOptions {
            return self.groupedSections(
                visible,
                groups: groups,
                options: viewOptions,
                peopleAvailable: owners.map { $0.count >= 2 } ?? true,
                selfOwnerID: selfOwnerID,
                sectionOrder: sectionOrder)
        }
        // Pin state owns first placement. Group sections then preserve the
        // same tree builder, so grouped parent/child rosters still nest.
        let pinned = self.tree(from: OpenClawChatSessionListOrganizer.organize(visible.filter { $0.pinned == true }))
        let unpinned = visible.filter { $0.pinned != true }
        let orderedGroups = groups.sorted { lhs, rhs in
            lhs.position == rhs.position ? lhs.name < rhs.name : lhs.position < rhs.position
        }
        let groupNames = Set(orderedGroups.map(\.name))
        let recent = self.tree(from: unpinned.filter { session in
            guard let category = session.category else { return true }
            return !groupNames.contains(category)
        })

        var result: [Section] = []
        if !pinned.isEmpty {
            result.append(Section(id: "pinned", title: "Pinned", nodes: pinned))
        }
        for group in orderedGroups {
            let nodes = self.tree(from: unpinned.filter { $0.category == group.name })
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

    static func tree(from sessions: [OpenClawChatSessionEntry]) -> [Node] {
        let hierarchyPresent = sessions.contains { session in
            ChatPayloadDecoding.trimmedNonEmptyString(session.spawnedBy) != nil ||
                ChatPayloadDecoding.trimmedNonEmptyString(session.parentSessionKey) != nil ||
                session.childSessions != nil
        }
        guard hierarchyPresent else {
            return sessions.map { self.node(session: $0, children: []) }
        }

        let sessionKeys = Set(sessions.map(\.key))
        var parentByChild: [String: String] = [:]
        // The gateway child roster is freshness-filtered and omitted when
        // empty. Persisted parent metadata can outlive that freshness window,
        // so it is display metadata only and must not recreate stale edges.
        for parent in sessions {
            for childKey in parent.childSessions ?? [] where childKey != parent.key {
                if sessionKeys.contains(childKey), parentByChild[childKey] == nil {
                    parentByChild[childKey] = parent.key
                }
            }
        }

        var orderByKey: [String: Int] = [:]
        for (offset, session) in sessions.enumerated() where orderByKey[session.key] == nil {
            orderByKey[session.key] = offset
        }
        for session in sessions {
            var path: [String] = []
            var indexByKey: [String: Int] = [:]
            var cursor: String? = session.key
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
            if let parentKey = parentByChild[session.key] {
                childrenByParent[parentKey, default: []].append(session)
            }
        }

        func build(_ session: OpenClawChatSessionEntry) -> Node {
            Self.node(session: session, children: (childrenByParent[session.key] ?? []).map(build))
        }

        return sessions.compactMap { session in
            guard parentByChild[session.key] == nil else { return nil }
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
        guard let key = change.sessionKey else { return sessions }
        guard let index = sessions.firstIndex(where: { $0.key == key }) else { return nil }
        guard let projection = self.observerProjection(for: change, activeAgentId: activeAgentId)
        else { return sessions }

        var session = sessions[index]
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
        return updated
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

    private static func activeAgentStatus(
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
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        excludesMainSession: Bool,
        sessionRoutingContract: String?,
        visibility: (options: ViewOptions?, now: Date)) -> [OpenClawChatSessionEntry]
    {
        let (viewOptions, now) = visibility
        let scopedSessions = sessions.filter {
            self.isSessionInActiveAgentScope(key: $0.key, agentID: $0.agentId, activeAgentID: activeAgentID)
        }
        let selectedSessionKey = self.selectedSessionKey(
            sessions: scopedSessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            sessionRoutingContract: sessionRoutingContract)
        let resolvedMainSessionKey = self.selectedSessionKey(
            sessions: scopedSessions,
            currentSessionKey: "main",
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            sessionRoutingContract: sessionRoutingContract)
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let selectedIsResolvedAlias = (normalizedCurrent == "main" || normalizedCurrent == "global") &&
            selectedSessionKey.lowercased() != normalizedCurrent
        let selectedIsMain = normalizedCurrent == "main" ||
            selectedSessionKey.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame
        var entries = scopedSessions.filter { entry in
            if excludesMainSession,
               entry.key.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame
            {
                // Home owns the main row. Removing it before tree construction
                // naturally promotes any retained child rows to section roots.
                return false
            }
            if selectedIsResolvedAlias, entry.key.lowercased() == normalizedCurrent {
                return false
            }
            let status = viewOptions?.status ?? .active
            return (entry.key == selectedSessionKey &&
                (viewOptions == nil || status.includes(entry, now: now))) ||
                (!self
                    .isHiddenInternalSession(entry.key) &&
                    status.includes(entry, now: now) &&
                    (viewOptions?.includes(entry) ?? true))
        }
        let selected = scopedSessions.first { $0.key == selectedSessionKey }
        let selectedMatchesStatus = selected.map { (viewOptions?.status ?? .active).includes($0, now: now) } ?? true
        if viewOptions?.status != .archived, viewOptions?.status != .snoozed,
           viewOptions == nil || selectedMatchesStatus,
           viewOptions?.ownerFilter.isEmpty != false,
           !(excludesMainSession && selectedIsMain),
           !entries.contains(where: { $0.key == selectedSessionKey }),
           self.isSessionInActiveAgentScope(key: selectedSessionKey, activeAgentID: activeAgentID),
           !currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            // Sessions can lag behind a fresh switch/new-session; keep the
            // active row selectable instead of showing an empty selection.
            entries.append(OpenClawChatSessionEntry(key: currentSessionKey))
        }
        return entries
    }
}
