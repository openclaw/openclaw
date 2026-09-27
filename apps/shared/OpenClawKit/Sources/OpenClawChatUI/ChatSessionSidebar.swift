#if os(macOS)
import SwiftUI

extension ChatSessionSidebarModel.Node {
    fileprivate var outlineChildren: [Self]? {
        self.children.isEmpty ? nil : self.children
    }

    fileprivate var previewSessions: [OpenClawChatSessionEntry] {
        [self.session] + self.children.flatMap(\.previewSessions)
    }
}

@MainActor
struct ChatSessionSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var query: String
    var additionalAttentionRequests: [OpenClawChatAttentionRequest] = []
    @State private var presentedAttention: OpenClawChatAttentionPresentation?
    @State private var sessionPendingDeletion: OpenClawChatSessionEntry?
    @State private var sessionPendingRename: OpenClawChatSessionEntry?
    @State private var renameText = ""
    @State private var groups: [OpenClawChatSessionGroup] = []
    @State private var groupRefreshNonce = 0
    @State private var groupLoadFailed = false
    @State private var inspectedSession: OpenClawChatSessionEntry?
    @State private var isPresentingNewSessionOptions = false
    @State private var previews = ChatSessionSidebarPreviews()
    @AppStorage("openclaw.chat.collapsedSessionGroups") private var collapsedSessionGroups = ""

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            self.sidebar(now: context.date)
        }
    }

    private func sidebar(now: Date) -> some View {
        let sections = ChatSessionSidebarModel.sections(
            sessions: self.viewModel.sessions,
            currentSessionKey: self.viewModel.sessionKey,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: self.viewModel.selectedAgentID,
            groups: self.groups,
            query: self.query,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract)
        let previewRequest = ChatSessionSidebarPreviews.Request(
            viewModel: self.viewModel,
            sessions: sections.flatMap(\.nodes).flatMap(\.previewSessions))
        return List(selection: self.selectionBinding) {
            self.newThreadButton
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 16, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            self.agentsSection(now: now)
            self.threadsHeading
            ForEach(sections) { section in
                if section.id.hasPrefix("group:"), let title = section.title {
                    let attention = self.attentionSummary(sessions: section.nodes.flatMap(\.previewSessions), now: now)
                    Section {
                        if !self.isGroupCollapsed(title) || !self.query
                            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        {
                            self.rows(section.nodes, now: now, previewRequest: previewRequest)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Button {
                                self.toggleGroupCollapsed(title)
                            } label: {
                                HStack {
                                    Image(systemName: self.isGroupCollapsed(title) ? "chevron.right" : "chevron.down")
                                    Text(verbatim: title)
                                        .font(OpenClawChatTypography.caption)
                                }
                            }
                            .buttonStyle(.plain)
                            Spacer(minLength: 0)
                            self.attentionBadge(summary: attention, targetID: section.id)
                        }
                        .modifier(ChatSidebarAttentionAccessibility(
                            title: title,
                            targetID: section.id,
                            summary: attention,
                            metadata: [],
                            presentation: self.$presentedAttention))
                    }
                } else if let title = section.title {
                    Section {
                        self.rows(section.nodes, now: now, previewRequest: previewRequest)
                    } header: {
                        Text(LocalizedStringKey(title))
                            .font(OpenClawChatTypography.caption)
                    }
                } else {
                    Section {
                        self.rows(section.nodes, now: now, previewRequest: previewRequest)
                    } header: {
                        Text("Recent")
                            .font(OpenClawChatTypography.caption)
                    }
                }
            }
            if sections.isEmpty {
                Text(self.query
                    .isEmpty ? String(localized: "No threads yet") : String(localized: "No matching threads"))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
                    .listRowSeparator(.hidden)
                    .selectionDisabled()
            }
        }
        .listStyle(.sidebar)
        .listItemTint(.monochrome)
        .searchable(
            text: self.$query,
            placement: .sidebar,
            prompt: String(localized: "Search threads"))
        .safeAreaInset(edge: .bottom, spacing: 0) { self.connectionFooter }
        .task(id: previewRequest) {
            let model = self.viewModel
            let cache = model.transcriptCache
            await model.pendingCacheWriteTask?.value
            guard !Task.isCancelled, ObjectIdentifier(self.viewModel) == previewRequest.modelID else { return }
            await self.previews.refresh(previewRequest, cache: cache)
        }
        .task(id: self.groupRefreshID) {
            self.viewModel.refreshSessions(limit: 200)
            do {
                let groups = try await self.viewModel.fetchSessionGroups()
                self.groups = groups
                self.groupLoadFailed = false
            } catch {
                self.groupLoadFailed = true
            }
        }
        .onChange(of: self.viewModel.healthOK) { previous, current in
            if !previous, current {
                self.viewModel.refreshSessions(limit: 200)
            }
        }
        .sheet(item: self.$inspectedSession) { session in
            ChatSessionInspectorSheet(viewModel: self.viewModel, session: session)
        }
        .alert(
            String(localized: "Rename Thread"),
            isPresented: self.isPresentingRenameAlert)
        {
            TextField(String(localized: "Thread name"), text: self.$renameText)
            Button(String(localized: "Rename")) {
                if let session = self.sessionPendingRename {
                    self.viewModel.renameSession(key: session.key, label: self.renameText, agentID: session.agentId)
                }
                self.sessionPendingRename = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) {
                self.sessionPendingRename = nil
            }
        }
        .confirmationDialog(self.deleteDialogTitle, isPresented: self.isPresentingDeleteDialog) {
                Button(String(localized: "Delete Thread"), role: .destructive) {
                    if let session = self.sessionPendingDeletion {
                        self.viewModel.deleteSession(session.key, agentID: session.agentId)
                    }
                    self.sessionPendingDeletion = nil
                }
            } message: {
                Text(String(localized: "The thread and its transcript are removed from the gateway."))
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
    }

    private var selectionBinding: Binding<String?> {
        Binding(
            get: {
                ChatSessionSidebarModel.selectedSessionKey(
                    sessions: self.viewModel.sessions,
                    currentSessionKey: self.viewModel.sessionKey,
                    mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
                    activeAgentID: self.viewModel.selectedAgentID,
                    sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                        self.viewModel.sessionRoutingContract)
            },
            set: { next in
                guard let next, next != self.viewModel.sessionKey else { return }
                let agentID = self.viewModel.sessions.first(where: { $0.key == next })?.agentId
                self.viewModel.switchSession(to: next, agentID: agentID)
            })
    }

    private var newThreadButton: some View {
        HStack(spacing: 0) {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.pencil")
                    Text("New Thread")
                    Spacer(minLength: 4)
                    Text(verbatim: "⇧⌘N")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(height: 38)
                .contentShape(Rectangle())
            }
            .help(String(localized: "New thread"))
            .accessibilityIdentifier("chat-new-thread")
            Divider()
                .frame(height: 16)
            Button {
                self.isPresentingNewSessionOptions = true
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 30, height: 38)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "New thread options"))
            .help(String(localized: "New thread options"))
            .popover(isPresented: self.$isPresentingNewSessionOptions) {
                ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                    self.isPresentingNewSessionOptions = false
                }
            }
        }
        .font(OpenClawChatTypography.body(size: 13, weight: .medium, relativeTo: .body))
        .buttonStyle(.plain)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.primary.opacity(0.08), lineWidth: 1)
        }
        .disabled(self.viewModel.isCreatingSession)
    }

    private func agentsSection(now: Date) -> some View {
        Section {
            ForEach(self.viewModel.agentChoices) { agent in
                self.agentRow(agent, now: now)
                    .selectionDisabled()
                    .listRowInsets(EdgeInsets(top: 1, leading: 4, bottom: 1, trailing: 4))
                    .listRowBackground(Color.clear)
            }
            if let error = self.viewModel.agentsErrorText {
                VStack(alignment: .leading, spacing: 6) {
                    Text(error)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Button("Retry") {
                        Task { await self.viewModel.refreshAgents() }
                    }
                    .disabled(self.viewModel.isLoadingAgents)
                }
                .selectionDisabled()
            } else if self.viewModel.isLoadingAgents, self.viewModel.agentChoices.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading agents…")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                .selectionDisabled()
            } else if self.viewModel.agentChoices.isEmpty {
                Text("No agents are available on this gateway.")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .selectionDisabled()
            }
        } header: {
            Text("Agents")
                .font(OpenClawChatTypography.caption)
        }
    }

    private var threadsHeading: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Threads")
                .font(OpenClawChatTypography.body(size: 12, weight: .semibold, relativeTo: .body))
            Spacer(minLength: 8)
            Text(verbatim: self.viewModel.selectedAgent?.displayName ?? self.viewModel.selectedAgentID ?? "")
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.top, 14)
        .padding(.bottom, 2)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .selectionDisabled()
        .accessibilityElement(children: .combine)
    }

    private func agentRow(_ agent: OpenClawChatAgentChoice, now: Date) -> some View {
        let isSelected = agent.id.lowercased() == self.viewModel.selectedAgentID
        let summary = ChatSessionSidebarModel.agentSummary(
            for: agent.id, sessions: self.viewModel.sessions, now: now.timeIntervalSince1970 * 1000)
        let attention = self.attentionSummary(
            sessions: self.viewModel.sessions.filter {
                ChatSessionSidebarModel.isSessionInActiveAgentScope(
                    key: $0.key, agentID: $0.agentId, activeAgentID: agent.id)
            },
            agentID: agent.id,
            now: now)
        return HStack(spacing: 4) {
            Button {
                self.viewModel.switchAgent(to: agent.id)
            } label: {
                HStack(spacing: 8) {
                    ChatSidebarAgentAvatar(agent: agent, size: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: agent.displayName)
                            .font(OpenClawChatTypography.body(
                                size: 13,
                                weight: isSelected ? .medium : .regular,
                                relativeTo: .body))
                            .lineLimit(1)
                        if self.viewModel.healthOK, let summary, let activity = summary.activity {
                            Label(self.agentSubtitle(summary, activity: activity), systemImage: activity.symbol)
                                .font(OpenClawChatTypography.body(size: 10, weight: .regular, relativeTo: .caption))
                                .foregroundStyle(summary.attentionCount > 0 ? OpenClawChatTheme.warning : .secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if let unread = summary?.unreadCount, unread > 0 {
                        Text(unread, format: .number)
                            .font(OpenClawChatTypography.body(size: 10, weight: .semibold, relativeTo: .caption))
                            .monospacedDigit()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                            .accessibilityLabel(unread == 1
                                ? String(localized: "1 unread thread")
                                : String(format: String(localized: "%lld unread threads"), unread))
                    } else if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-agent-\(agent.id)")
            .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            .help(String(format: String(localized: "Open %@"), agent.displayName))
            self.attentionBadge(summary: attention, targetID: "agent:\(agent.id)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(isSelected ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }

    private func agentSubtitle(
        _ summary: ChatSessionSidebarModel.AgentSummary,
        activity: ChatSessionSidebarModel.Activity) -> String
    {
        if summary.attentionCount > 1 {
            return String(format: String(localized: "%lld need attention"), summary.attentionCount)
        }
        if summary.runningCount > 1 {
            return String(format: String(localized: "%lld working · %@"), summary.runningCount, activity.text)
        }
        if summary.queuedCount > 1 {
            return String(format: String(localized: "%lld queued"), summary.queuedCount)
        }
        return activity.text
    }

    private var groupRefreshID: String {
        let categories = self.viewModel.sessions.compactMap(\.category).sorted().joined(separator: "|")
        let revision = self.viewModel.sessionGroupsRevision
        return "\(self.viewModel.healthOK)|\(categories)|\(revision)|\(self.groupRefreshNonce)"
    }

    private var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return String(format: String(localized: "Delete “%@”?"), name)
    }

    private var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
    }

    private var isPresentingRenameAlert: Binding<Bool> {
        Binding(
            get: { self.sessionPendingRename != nil },
            set: { if !$0 { self.sessionPendingRename = nil } })
    }

    private func rows(
        _ nodes: [ChatSessionSidebarModel.Node],
        now: Date,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        OutlineGroup(nodes, children: \.outlineChildren) { node in
            self.row(for: node, now: now, previewRequest: previewRequest)
        }
    }

    private func row(
        for node: ChatSessionSidebarModel.Node,
        now: Date,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        let session = node.session
        let attention = self.attentionSummary(sessions: node.previewSessions, now: now)
        let targetID = "session:\(session.key)"
        let subtitle = self.rowSubtitle(for: session, now: now, previewRequest: previewRequest)
        let timestamp = ChatSessionSidebarModel.activityTimestamp(for: session).map {
            Date(timeIntervalSince1970: $0 / 1000).formatted(.relative(
                presentation: .named, unitsStyle: .abbreviated))
        }
        return HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ChatSessionSidebarModel.displayName(for: session))
                    .font(OpenClawChatTypography.body(
                        size: 13, weight: session.unread == true ? .medium : .regular, relativeTo: .body))
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                if let timestamp {
                    Text(verbatim: timestamp)
                        .font(OpenClawChatTypography.body(size: 10, weight: .regular, relativeTo: .caption))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                HStack(spacing: 5) {
                    self.attentionBadge(summary: attention, targetID: targetID)
                    self.badges(for: node)
                }
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: session.color)
                .offset(x: -6)
        }
        // The tag type must equal the List selection type (String?) exactly.
        .tag(Optional(session.key))
        .contextMenu { self.contextMenu(for: session) }
        .modifier(ChatSidebarAttentionAccessibility(
            title: ChatSessionSidebarModel.displayName(for: session),
            targetID: targetID,
            summary: attention,
            metadata: [subtitle, timestamp].compactMap(\.self),
            presentation: self.$presentedAttention,
            isOutlineHeading: !node.children.isEmpty))
    }

    private func attentionSummary(
        sessions: [OpenClawChatSessionEntry],
        agentID: String? = nil,
        now: Date) -> OpenClawChatAttentionSummary?
    {
        let requests = self.viewModel.pendingQuestionAttentionRequests + self.additionalAttentionRequests
        return ChatSessionSidebarModel.attentionSummary(
            requests: requests,
            sessions: sessions,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: agentID ?? self.viewModel.selectedAgentID,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract,
            now: now)
    }

    @ViewBuilder
    private func attentionBadge(summary: OpenClawChatAttentionSummary?, targetID: String) -> some View {
        if let summary {
            OpenClawChatAttentionBadge(
                summary: summary, targetID: targetID, presentation: self.$presentedAttention)
        }
    }

    @ViewBuilder
    private func badges(for node: ChatSessionSidebarModel.Node) -> some View {
        if self.viewModel.healthOK, node.badges.queuedCount > 0 {
            Image(systemName: "hourglass")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread queued"))
        }
        if self.viewModel.healthOK, node.badges.runningCount > 0 {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel(String(localized: "Thread running"))
        }
        if node.badges.failedCount > 0 {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread failed"))
        }
        let isCurrentSession = self.viewModel.matchesCurrentSessionKey(
            incoming: node.session.key,
            current: self.viewModel.sessionKey)
        if node.children.contains(where: \.badges.hasUnread) ||
            (node.session.unread == true && !isCurrentSession)
        {
            Circle()
                .fill(.tint)
                .frame(width: 7, height: 7)
                .accessibilityLabel(String(localized: "Unread"))
        }
    }

    @ViewBuilder
    private func contextMenu(for session: OpenClawChatSessionEntry) -> some View {
        Button {
            self.inspectedSession = session
        } label: {
            self.actionLabel(String(localized: "Get Info…"), systemImage: "info.circle")
        }
        Divider()
        Button {
            self.renameText = session.label ?? session.displayName ?? ""
            self.sessionPendingRename = session
        } label: {
            self.actionLabel(String(localized: "Rename…"), systemImage: "pencil")
        }
        Button {
            self.viewModel.setSessionPinned(key: session.key, pinned: session.pinned != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"),
                systemImage: session.pinned == true ? "pin.slash" : "pin")
        }
        Button {
            Task {
                await self.viewModel.forkSession(
                    key: session.key,
                    fromLastCompleted: session.hasActiveRun == true,
                    agentID: session.agentId)
            }
        } label: {
            self.actionLabel(
                session.hasActiveRun == true
                    ? String(localized: "Fork from last completed message")
                    : String(localized: "Fork"),
                systemImage: "arrow.triangle.branch")
        }
        Button {
            self.viewModel.setSessionUnread(key: session.key, unread: session.unread != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.unread == true ? String(localized: "Mark Read") : String(localized: "Mark Unread"),
                systemImage: session.unread == true ? "envelope.open" : "envelope.badge")
        }
        if ChatSessionSidebarModel.canArchiveSession(
            session,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button {
                self.viewModel.setSessionArchived(session, archived: !session.isArchived)
            } label: {
                self.actionLabel(
                    session.isArchived ? String(localized: "Restore") : String(localized: "Archive"),
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
        }
        OpenClawSessionColorMenu(color: session.color) { color in
            Task { await self.viewModel.setSessionColor(key: session.key, color: color, agentID: session.agentId) }
        }
        Divider()
        Button {
            ChatPasteboard.copy(session.key)
        } label: {
            self.actionLabel(String(localized: "Copy Session Key"), systemImage: "doc.on.doc")
        }
        if ChatSessionSidebarModel.canDeleteSession(
            key: session.key,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button(role: .destructive) {
                self.sessionPendingDeletion = session
            } label: {
                self.actionLabel(String(localized: "Delete Thread…"), systemImage: "trash")
            }
        }
    }

    private func isGroupCollapsed(_ name: String) -> Bool {
        Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init)).contains(name)
    }

    private func toggleGroupCollapsed(_ name: String) {
        var names = Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init))
        if !names.insert(name).inserted {
            names.remove(name)
        }
        self.collapsedSessionGroups = names.sorted().joined(separator: "\u{1F}")
    }

    private func actionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    }

    private func rowSubtitle(
        for session: OpenClawChatSessionEntry,
        now: Date,
        previewRequest: ChatSessionSidebarPreviews.Request) -> String?
    {
        let activity = ChatSessionSidebarModel.activity(for: session, now: now.timeIntervalSince1970 * 1000)
        if let activity, activity.kind == .attention { return activity.text }
        if self.viewModel.healthOK, let activity, [.running, .queued].contains(activity.kind) { return activity.text }
        if let activity, activity.kind == .failed,
           session.unread == true || (session.lastReadAt ?? 0) < (session.endedAt ?? session.updatedAt ?? 0)
        { return activity.text }
        if self.viewModel.matchesCurrentSessionKey(
            incoming: session.key, agentId: session.agentId, current: self.viewModel.sessionKey),
            let current = ChatSessionSidebarModel.messagePreview(from: self.viewModel.messages)
        { return current }
        if let preview = self.previews.text(for: session, in: previewRequest) { return preview }
        let workSubtitle = ChatSessionSidebarModel.workSubtitle(for: session)
        if !self.viewModel.healthOK, let activity, [.running, .queued].contains(activity.kind) { return workSubtitle }
        return ChatSessionSidebarModel.subtitle(
            for: session,
            workSubtitle: workSubtitle,
            now: now.timeIntervalSince1970 * 1000)
    }

    private var connectionFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.healthOK
                ? String(localized: "Gateway connected")
                : String(localized: "Connecting…"))
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if self.groupLoadFailed {
                Button {
                    self.groupRefreshNonce += 1
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help(String(localized: "Retry thread groups"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(.bar)
    }
}

struct ChatSidebarAgentAvatar: View {
    let agent: OpenClawChatAgentChoice
    var size: CGFloat = 28

    var body: some View {
        Text(self.avatarText)
            .font(OpenClawChatTypography.navigationAvatar(size: self.size * 0.5))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(width: self.size, height: self.size)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: self.size * 0.3))
            .accessibilityHidden(true)
    }

    private var avatarText: String {
        if let emoji = self.agent.emoji?.trimmingCharacters(in: .whitespacesAndNewlines), !emoji.isEmpty {
            return String(emoji.prefix(1))
        }
        return String(self.agent.displayName.prefix(1)).uppercased()
    }
}

private struct ChatSidebarAttentionAccessibility: ViewModifier {
    let title: String
    let targetID: String
    let summary: OpenClawChatAttentionSummary?
    let metadata: [String]
    @Binding var presentation: OpenClawChatAttentionPresentation?
    var isOutlineHeading = true

    func body(content: Content) -> some View {
        if self.isOutlineHeading {
            content
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text(verbatim: self.title))
                .accessibilityValue(Text(verbatim: (
                    self.metadata + [self.summary?.accessibilityText].compactMap(\.self)).joined(separator: ". ")))
                .accessibilityIdentifier("chat-attention-host:\(self.targetID)")
                .accessibilityActions {
                    if let summary = self.summary {
                        Button("Show pending request details") {
                            self.presentation = OpenClawChatAttentionPresentation(
                                targetID: self.targetID, requestID: summary.disclosureIdentity)
                        }
                    }
                }
        } else {
            content.accessibilityElement(children: .contain)
        }
    }
}
#endif
