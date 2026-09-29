#if os(macOS)
import SwiftUI

@MainActor
struct ChatCommandPalette: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let sections: [ChatSessionSidebarModel.Section]
    let additionalAttentionRequests: [OpenClawChatAttentionRequest]
    let preview: (OpenClawChatSessionEntry) -> String?
    let onAction: (ChatCommandPaletteAction) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isSearchFocused: Bool
    @State private var query = ""
    @State private var selection: String?
    @State private var search = ChatCommandPaletteSearch()
    @State private var presentedAttention: OpenClawChatAttentionPresentation?

    private var request: ChatCommandPaletteSearch.Request {
        .init(
            query: self.query.trimmingCharacters(in: .whitespacesAndNewlines),
            target: self.viewModel.currentSessionTarget)
    }

    private var items: [ChatCommandPaletteItem] {
        ChatCommandPaletteModel.items(
            agents: self.viewModel.agentChoices,
            activeAgentID: self.viewModel.selectedAgentID,
            sections: self.sections,
            remote: self.search.rows(for: self.request),
            query: self.query,
            preview: self.preview).filter { item in
            guard self.viewModel.usesWebConversation else { return true }
            switch item {
            case .action(.find), .action(.export): return false
            default: return true
            }
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            self.palette(now: context.date)
        }
    }

    private func palette(now: Date) -> some View {
        let items = self.items
        let selectableIDs = items.filter(self.isEnabled).map(\.id)
        let selectedID = ChatCommandPaletteModel.selection(in: selectableIDs, current: self.selection)
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search agents, threads, and actions", text: self.$query)
                    .textFieldStyle(.plain)
                    .focused(self.$isSearchFocused)
                    .onSubmit { self.activate(items.first { $0.id == selectedID }) }
                    .onKeyPress(.upArrow) {
                        self.selection = ChatCommandPaletteModel.selection(
                            in: selectableIDs, current: selectedID, direction: -1)
                        return .handled
                    }
                    .onKeyPress(.downArrow) {
                        self.selection = ChatCommandPaletteModel.selection(
                            in: selectableIDs, current: selectedID, direction: 1)
                        return .handled
                    }
                    .accessibilityIdentifier("chat-command-palette-search")
                if self.search.isLoading, self.search.request == self.request {
                    ProgressView().controlSize(.small).accessibilityLabel("Searching threads")
                }
                Button { self.dismiss() } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
                .help("Close command palette (Escape)")
                .accessibilityLabel("Close command palette")
            }
            .padding(16)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            if index == 0 || items[index - 1].group != item.group {
                                Text(verbatim: item.group)
                                    .font(OpenClawChatTypography.captionSemiBold)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 10)
                                    .padding(.top, 12)
                                    .padding(.bottom, 4)
                            }
                            self.row(item, isSelected: item.id == selectedID, now: now)
                                .id(item.id)
                        }
                        if items.isEmpty {
                            Text("No matches")
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity)
                                .padding(24)
                        }
                    }
                    .padding(8)
                }
                .onChange(of: selectedID) { _, id in
                    if let id { proxy.scrollTo(id) }
                }
            }
            Divider()
            Text("↑↓ Navigate · Return Open · Escape Close")
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
        .frame(width: 540, height: 440)
        .onAppear { self.isSearchFocused = true }
        .onExitCommand { self.dismiss() }
        .onChange(of: self.query) { _, _ in self.selection = nil }
        .task(id: self.request) { await self.searchThreads() }
        .accessibilityIdentifier("chat-command-palette")
    }

    private func isEnabled(_ item: ChatCommandPaletteItem) -> Bool {
        switch item {
        case .action(.newThread): !self.viewModel.isCreatingSession
        case .action(.export): !self.viewModel.messages.isEmpty
        default: true
        }
    }

    private func activate(_ item: ChatCommandPaletteItem?) {
        guard let item, self.isEnabled(item) else { return }
        switch item {
        case let .agent(agent): self.viewModel.switchAgent(to: agent.id)
        case let .thread(node):
            self.viewModel.switchSession(to: node.session.key, agentID: node.session.agentId)
        case let .action(action): self.onAction(action)
        }
        self.dismiss()
    }

    private func row(_ item: ChatCommandPaletteItem, isSelected: Bool, now: Date) -> some View {
        HStack(spacing: 6) {
            Button { self.activate(item) } label: {
                self.rowContent(item, now: now)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!self.isEnabled(item))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            .accessibilityIdentifier("chat-palette-\(item.id)")
            if let summary = self.attentionSummary(item, now: now) {
                OpenClawChatAttentionBadge(
                    summary: summary, targetID: item.id, presentation: self.$presentedAttention)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            isSelected ? OpenClawChatTheme.accent.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func rowContent(_ item: ChatCommandPaletteItem, now: Date) -> some View {
        switch item {
        case let .agent(agent):
            HStack(spacing: 10) {
                ChatSidebarAgentAvatar(agent: agent, size: 28)
                Text(verbatim: agent.displayName)
                Spacer(minLength: 0)
                if let summary = ChatSessionSidebarModel.agentSummary(
                    for: agent.id, sessions: self.viewModel.sessions, now: now.timeIntervalSince1970 * 1000),
                    self.viewModel.healthOK, let activity = summary.activity
                {
                    Label(activity.text, systemImage: activity.symbol)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(summary.attentionCount > 0 ? OpenClawChatTheme.warning : .secondary)
                        .lineLimit(1)
                }
            }
        case let .thread(node):
            self.threadContent(node, now: now)
        case let .action(action):
            HStack(spacing: 10) {
                Image(systemName: action.symbol).frame(width: 28)
                Text(verbatim: action.title)
                Spacer()
                Text(verbatim: action.shortcut).foregroundStyle(.secondary)
            }
        }
    }

    private func threadContent(_ node: ChatSessionSidebarModel.Node, now: Date) -> some View {
        let session = node.session
        let agentID = session.agentId ?? OpenClawChatSessionKey.agentID(from: session.key) ??
            self.viewModel.selectedAgentID ?? ""
        let agent = self.viewModel.agentChoices.first { $0.id == agentID } ?? .init(id: agentID)
        let presentation = ChatSessionRowPresentation(
            session: session,
            isConnected: self.viewModel.healthOK,
            preview: self.preview(session),
            now: now)
        return HStack(spacing: 10) {
            ChatSidebarAgentAvatar(agent: agent, size: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(ChatSessionSidebarModel.displayName(for: session))
                        .fontWeight(session.unread == true ? .medium : .regular)
                    Spacer(minLength: 4)
                    if let timestamp = presentation.timestamp {
                        Text(verbatim: timestamp)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                HStack {
                    if agent.id.caseInsensitiveCompare(self.viewModel.selectedAgentID ?? "") != .orderedSame {
                        Text(verbatim: agent.displayName).foregroundStyle(.secondary)
                    }
                    if let subtitle = presentation.subtitle {
                        Text(verbatim: subtitle).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    ChatSidebarSessionBadges(
                        node: node,
                        isConnected: self.viewModel.healthOK,
                        isCurrentSession: self.viewModel.matchesCurrentSessionKey(
                            incoming: session.key, agentId: session.agentId, current: self.viewModel.sessionKey))
                }
                .font(OpenClawChatTypography.caption)
            }
            .lineLimit(1)
        }
    }

    private func attentionSummary(_ item: ChatCommandPaletteItem, now: Date) -> OpenClawChatAttentionSummary? {
        let sessions: [OpenClawChatSessionEntry]
        let agentID: String?
        switch item {
        case let .agent(agent):
            agentID = agent.id
            sessions = self.viewModel.sessions.filter {
                ChatSessionSidebarModel.isSessionInActiveAgentScope(
                    key: $0.key, agentID: $0.agentId, activeAgentID: agent.id)
            }
        case let .thread(node):
            agentID = node.session.agentId ?? self.viewModel.selectedAgentID
            sessions = node.previewSessions
        case .action: return nil
        }
        return ChatSessionSidebarModel.attentionSummary(
            requests: self.viewModel.pendingQuestionAttentionRequests + self.additionalAttentionRequests,
            sessions: sessions,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: agentID,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract,
            now: now)
    }

    private func searchThreads() async {
        guard !Task.isCancelled else { return }
        let request = self.request
        let generation = self.search.begin(request)
        guard !request.query.isEmpty else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            try Task.checkCancellation()
            let rows = await self.viewModel.fetchSessionList(search: request.query, archived: false)
            try Task.checkCancellation()
            guard self.request == request else { return }
            self.search.complete(rows, generation: generation)
        } catch is CancellationError {
            // The replacement task (or dismissed sheet) owns the presentation.
        } catch {
            self.search.complete([], generation: generation)
        }
    }
}
#endif
