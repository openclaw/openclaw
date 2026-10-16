#if os(macOS)
import SwiftUI

struct ChatSidebarAgentReveal {
    var limits: [String: Int] = [:]
    var members: [String: Set<String>] = [:]

    func visible(
        _ rows: [ChatSessionSidebarModel.Node],
        agentID: String,
        selected: (ChatSessionSidebarModel.Node) -> Bool)
        -> [ChatSessionSidebarModel.Node]
    {
        /// Rendering and hydration must retain the root containing the selected descendant.
        func containsSelection(_ node: ChatSessionSidebarModel.Node) -> Bool {
            selected(node) || node.children.contains(where: containsSelection)
        }
        // ui/src/components/app-sidebar-session-projection.ts:268 retains one bounded previous page.
        let limit = self.limits[agentID] ?? 10
        var slots = max(0, limit - rows.filter(containsSelection).count), retained = limit
        return rows.filter { row in
            if containsSelection(row) { return true }
            if slots > 0 { slots -= 1
                return true
            }
            guard retained > 0, self.members[agentID]?.contains(row.id) == true else { return false }
            retained -= 1
            return true
        }
    }
}

struct ChatSidebarTreeSummary {
    let sessions: [OpenClawChatSessionEntry]
    let running: Int
    let queued: Int
    let failed: Int
    let unread: Int
    let conflicts: Int

    init(page: ChatSessionSidebarModel.Node, expanded: Bool, isConnected: Bool) {
        // ui/src/components/session-attention-presentation.ts:173 excludes visible children from expanded Page signals.
        self.init(home: page, rows: page.children, collapsed: !expanded, isConnected: isConnected)
    }

    init(
        home: ChatSessionSidebarModel.Node?,
        rows: [ChatSessionSidebarModel.Node],
        collapsed: Bool,
        isConnected: Bool = true)
    {
        // app-sidebar-agent-session-rows.ts:332 excludes promoted persistent children from Home's header summary.
        let children = home?.children ?? []
        let hidden = collapsed ? rows : []
        self.sessions = ((home.map { [$0.session] + $0.foldedSessions } ?? []) + hidden.flatMap(\.previewSessions))
            .filter { !$0.isArchived }
        // Cached run facts remain useful offline, but must not animate as current work.
        self.running = isConnected ? max(
            0,
            (home?.badges.runningCount ?? 0) - children.reduce(0) { $0 + $1.badges.runningCount }) +
            hidden.reduce(0) { $0 + $1.badges.runningCount } : 0
        self.queued = isConnected ? max(
            0,
            (home?.badges.queuedCount ?? 0) - children.reduce(0) { $0 + $1.badges.queuedCount }) +
            hidden.reduce(0) { $0 + $1.badges.queuedCount } : 0
        self.failed = max(0, (home?.badges.failedCount ?? 0) - children.reduce(0) { $0 + $1.badges.failedCount }) +
            hidden.reduce(0) { $0 + $1.badges.failedCount }
        self.unread = self.sessions.filter { $0.unread == true }.count
        self.conflicts = self.sessions.reduce(0) { min(
            9_007_199_254_740_991,
            $0 + ChatSessionSidebarRowFacts.workspaceConflicts($1)) }
    }
}

struct ChatSidebarSummarySignals: View {
    let summary: ChatSidebarTreeSummary
    let attention: OpenClawChatAttentionSummary?
    let now: Date
    var showsConflicts = false
    let targetID: String
    @Binding var presentedAttention: OpenClawChatAttentionPresentation?

    var body: some View {
        let activity = self.summary.sessions.compactMap {
            ChatSessionSidebarModel.activity(for: $0, now: self.now.timeIntervalSince1970 * 1000)
        }.first { $0.kind == .attention }
        HStack(spacing: 5) {
            if self.summary.unread > 0 {
                Text(self.summary.unread.formatted()).monospacedDigit().foregroundStyle(.tint)
                    .accessibilityLabel(String(format: String(localized: "%lld unread threads"), self.summary.unread))
            }
            if let attention = self.attention {
                OpenClawChatAttentionBadge(
                    summary: attention, targetID: self.targetID, presentation: self.$presentedAttention)
            } else if let activity {
                Image(systemName: activity.symbol).foregroundStyle(OpenClawChatTheme.warning).help(activity.text)
            } else if self.summary.failed > 0 {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(OpenClawChatTheme.danger)
                    .help(String(localized: "Thread failed"))
            } else if self.showsConflicts, self.summary.conflicts > 0 {
                Image(systemName: "globe").help(String(
                    format: String(localized: "%lld workspace conflicts"),
                    self.summary.conflicts))
            } else if self.summary.running > 0 {
                ProgressView().controlSize(.mini)
            } else if self.summary.queued > 0 {
                Image(systemName: "hourglass").help(String(localized: "Thread queued"))
            }
        }
    }
}

extension ChatSessionSidebar {
    var showsAllAgents: Bool {
        self.rosterData?.agentScope == .all
    }

    var showsAgentRoster: Bool {
        self.showsAllAgents && !self.viewModel.agentChoices.isEmpty && self.query
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func sessionAgentID(_ session: OpenClawChatSessionEntry) -> String? {
        ChatSessionSidebarModel.sidebarAgentID(session) ??
            (self.showsAllAgents ? self.viewModel.agentCatalog?.defaultId : self.viewModel.selectedAgentID)
    }

    var sidebarGatewayID: String? {
        (self.viewModel.transcriptCache as? OpenClawChatSQLiteTranscriptCache)?.gatewayID
    }

    @ViewBuilder var agentScopePicker: some View {
        if self.viewModel.agentChoices.count > 1 || self.showsAllAgents {
            Picker(String(localized: "Agent scope"), selection: Binding(
                get: { self.showsAllAgents }, set: { self.setAllAgents($0) }))
            {
                Text("Selected agent").tag(false)
                Text("All agents").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(self.rosterData == nil)
            .listRowSeparator(.hidden)
            .selectionDisabled()
        }
    }

    @ViewBuilder func pagesSection(
        _ sections: [ChatSessionSidebarModel.Section],
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        // app-sidebar.ts:445 keeps pinned trees in Pages; preserve the order supplied by sidebar interactions.
        if let pages = sections.first(where: { $0.id == "pinned" }) {
            self.sessionSection(
                .init(id: pages.id, title: String(localized: "Pages"), nodes: pages.nodes),
                now: now,
                ownership: ownership,
                previewRequest: previewRequest)
        }
    }

    func visibleAgentRows(_ nodes: [ChatSessionSidebarModel.Node], agentID: String) -> [ChatSessionSidebarModel.Node] {
        guard !self.collapsedAgentIDs.contains(agentID) else { return [] }
        return self.agentReveal.visible(nodes, agentID: agentID) { node in
            self.viewModel.matchesCurrentSessionKey(
                incoming: node.id, agentId: node.session.agentId, current: self.viewModel.sessionKey)
        }
    }

    @ViewBuilder func agentRoster(
        _ sections: [ChatSessionSidebarModel.Section],
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        if let error = self.viewModel.agentsErrorText {
            Text(verbatim: error).foregroundStyle(.secondary).selectionDisabled()
            Button(String(localized: "Retry")) { Task { await self.viewModel.refreshAgents() } }
                .disabled(self.viewModel.isLoadingAgents).selectionDisabled()
        }
        ForEach(self.viewModel.agentChoices) { agent in
            let nodes = sections.first { $0.id == "agent:\(agent.id):recent" }?.nodes ?? []
            let collapsed = self.collapsedAgentIDs.contains(agent.id)
            let visible = self.visibleAgentRows(nodes, agentID: agent.id)
            Section {
                if !collapsed {
                    ForEach(self.homeLoadParents(agentID: agent.id)) { self.childLoadState($0) }
                    self.rows(visible, now: now, ownership: ownership, previewRequest: previewRequest)
                    if visible.count < nodes.count {
                        Button(String(localized: "Show more")) { self.agentReveal.limits[agent.id, default: 10] += 10 }
                            .selectionDisabled()
                    }
                    // app-sidebar-session-list-render.ts:458 waits until more than thirty rendered rows.
                    if visible.count > 30 {
                        Button(String(localized: "See less")) {
                            self.agentReveal.limits[agent.id] = 10
                            self.agentReveal.members[agent.id] = []
                        }.selectionDisabled()
                    }
                }
            } header: {
                self.agentRosterHeader(agent, nodes: nodes, now: now)
            }
            .onChange(of: collapsed ? [] : visible.map(\.id), initial: true) { _, keys in
                self.agentReveal.members[agent.id] = Set(keys)
            }
        }
    }

    private func agentRosterHeader(
        _ agent: OpenClawChatAgentChoice,
        nodes: [ChatSessionSidebarModel.Node],
        now: Date) -> some View
    {
        let collapsed = self.collapsedAgentIDs.contains(agent.id)
        let isCurrent = self.viewModel.matchesCurrentSessionKey(
            incoming: self.viewModel.mainSessionKey(forAgent: agent.id),
            agentId: agent.id,
            current: self.viewModel.sessionKey)
        let summary = ChatSidebarTreeSummary(
            home: self.homeTree(agentID: agent.id),
            rows: nodes,
            collapsed: collapsed,
            isConnected: self.viewModel.healthOK)
        let attention = self.attentionSummary(
            sessions: summary.sessions, agentID: agent.id, now: now)
        return HStack(spacing: 6) {
            Button {
                var collapsed = self.collapsedAgentIDs
                if !collapsed.insert(agent.id).inserted { collapsed.remove(agent.id) }
                self.setCollapsedAgents(collapsed)
            } label: {
                Image(systemName: self.collapsedAgentIDs.contains(agent.id) ? "chevron.right" : "chevron.down")
            }
            .accessibilityLabel(self.collapsedAgentIDs.contains(agent.id)
                ? String(format: String(localized: "Expand %@"), agent.displayName)
                : String(format: String(localized: "Collapse %@"), agent.displayName))
            Button { self.openAgentMain(agent.id) } label: {
                HStack(spacing: 6) {
                    ChatSidebarAgentAvatar(agent: agent, size: 24)
                    Text(verbatim: agent.displayName).fontWeight(isCurrent ? .semibold : .regular).lineLimit(1)
                }
            }
            .accessibilityIdentifier("chat-agent-\(agent.id)")
            .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
            .padding(3)
            .background(isCurrent ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            Spacer(minLength: 0)
            if collapsed, !nodes.isEmpty {
                Text(nodes.count.formatted()).monospacedDigit()
                    .accessibilityLabel(String(format: String(localized: "%lld threads"), nodes.count))
            }
            ChatSidebarSummarySignals(
                summary: summary,
                attention: attention,
                now: now,
                showsConflicts: true,
                targetID: "agent:\(agent.id)",
                presentedAttention: self.$presentedAttention)
            Menu { self.agentRosterMenu(agent) } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel(String(format: String(localized: "%@ options"), agent.displayName))
        }
        .font(OpenClawChatTypography.caption)
        .buttonStyle(.plain)
        .contextMenu { self.agentRosterMenu(agent) }
    }

    @ViewBuilder private func agentRosterMenu(_ agent: OpenClawChatAgentChoice) -> some View {
        // ui/src/components/sidebar-agent-roster.ts:198 keeps all actions scoped to this header's agent.
        Button(String(localized: "New Session")) {
            Task { await self.viewModel.startNewSession(agentID: agent.id) }
        }
        .disabled(!self.viewModel.healthOK || self.viewModel.isCreatingSession)
        Button(String(localized: "Open main chat")) { self.openAgentMain(agent.id) }
        Button(String(localized: "All sessions")) {
            self.agentSessionsTarget = agent
        }
        Button(String(localized: "Collapse others")) {
            self.setCollapsedAgents(Set(self.viewModel.agentChoices.map(\.id).filter { $0 != agent.id }))
        }
    }

    private func openAgentMain(_ id: String) {
        self.viewModel.switchAgent(to: id)
    }

    func restoreAgentPresentation() {
        self.collapsedAgentIDs = self.sidebarGatewayID.map {
            Set(UserDefaults.standard.stringArray(forKey: "openclaw.chat.sidebar.collapsedAgents.\($0)") ?? [])
        } ?? []
        if let gatewayID = self.sidebarGatewayID {
            self.viewModel
                .updateSidebarQuery(agentScope: UserDefaults.standard
                    .bool(forKey: "openclaw.chat.sidebar.allAgents.\(gatewayID)") ? .all : .selected)
        }
    }

    private func setAllAgents(_ all: Bool) {
        self.viewModel.updateSidebarQuery(agentScope: all ? .all : .selected)
        if let gatewayID = self.sidebarGatewayID {
            UserDefaults.standard.set(all, forKey: "openclaw.chat.sidebar.allAgents.\(gatewayID)")
        }
    }

    func setCollapsedAgents(_ ids: Set<String>) {
        for id in ids.subtracting(self.collapsedAgentIDs) {
            self.agentReveal.members[id] = nil
        }
        self.collapsedAgentIDs = ids
        // ui/src/components/sidebar-agent-roster.ts:76 scopes saved collapse choices to the Gateway.
        if let gatewayID = self.sidebarGatewayID {
            UserDefaults.standard.set(ids.sorted(), forKey: "openclaw.chat.sidebar.collapsedAgents.\(gatewayID)")
        }
    }
}
#endif
