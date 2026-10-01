#if os(macOS)
import SwiftUI

extension ChatSessionSidebarModel.Node {
    fileprivate var outlineChildren: [Self]? {
        self.children.isEmpty ? nil : self.children
    }

    var previewSessions: [OpenClawChatSessionEntry] {
        [self.session] + self.children.flatMap(\.previewSessions)
    }
}

@MainActor
struct ChatSessionSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var query: String
    @Binding var groups: [OpenClawChatSessionGroup]
    let previews: ChatSessionSidebarPreviews
    let menuActions: ChatSessionSidebarActions
    var additionalAttentionRequests: [OpenClawChatAttentionRequest] = []
    @State var menuPresentation: ChatSessionIconPicker?
    @State var presentedAttention: OpenClawChatAttentionPresentation?
    @State var sessionPendingDeletion: OpenClawChatSessionEntry?
    @State var sessionPendingRename: OpenClawChatSessionEntry?
    @State var renameText = ""
    @State var groupRefreshNonce = 0
    @State var groupLoadFailed = false
    @State var inspectedSession: OpenClawChatSessionEntry?
    @State var isPresentingNewSessionOptions = false
    @AppStorage("openclaw.chat.collapsedSessionGroups") private var collapsedSessionGroups = ""
    @AppStorage("openclaw.chat.sidebar.sort") var sessionSort = ChatSessionSidebarModel.Sort.created
    @AppStorage("openclaw.chat.sidebar.showMessagePreview") var showMessagePreview = false
    @AppStorage("openclaw.chat.sidebar.showAutomationSessions") var showAutomationSessions = false
    @AppStorage("openclaw.chat.sidebar.showSystemSessions") var showSystemSessions = false
    @State private var observedOrder = ChatSessionSidebarModel.ObservedOrder()

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
            excludesMainSession: self.viewModel.selectedAgent != nil,
            query: self.query,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract,
            viewOptions: .init(
                sort: self.sessionSort,
                showAutomation: self.showAutomationSessions,
                showSystem: self.showSystemSessions),
            observedOrder: self.observedOrder)
        let previewRequest = ChatSessionSidebarPreviews.Request(
            viewModel: self.viewModel,
            sessions: sections.flatMap(\.nodes).flatMap(\.previewSessions))
        return List(selection: self.selectionBinding) {
            self.newThreadButton
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 16, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            ChatSidebarOnlineSection(viewModel: self.viewModel)
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
                        .contextMenu { self.groupMenu(title) }
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
        .onChange(of: self.viewModel.sessions.map(\.key), initial: true) { _, keys in
            self.observedOrder.observe(keys)
        }
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
        .sheet(item: self.$menuPresentation) { $0 }
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
                // List writes this binding inside its table selection delegate.
                // Navigation changes the same rows and focus, so leave that callback first.
                Task { @MainActor in
                    self.viewModel.switchSession(to: next, agentID: agentID)
                }
            })
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

    private var groupRefreshID: String {
        let categories = self.viewModel.sessions.compactMap(\.category).sorted().joined(separator: "|")
        let revision = self.viewModel.sessionGroupsRevision
        return "\(self.viewModel.healthOK)|\(categories)|\(revision)|\(self.groupRefreshNonce)"
    }

    private func rows(
        _ nodes: [ChatSessionSidebarModel.Node],
        now: Date,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        let rootIDs = Set(nodes.map(\.id))
        return OutlineGroup(nodes, children: \.outlineChildren) { node in
            self.row(
                for: node,
                isChild: !rootIDs.contains(node.id),
                now: now,
                previewRequest: previewRequest)
        }
    }

    private func isGroupCollapsed(_ name: String) -> Bool {
        self.collapsedSessionGroups.split(separator: "\u{1F}").contains(Substring(name))
    }

    private func toggleGroupCollapsed(_ name: String) {
        var names = Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init))
        if !names.insert(name).inserted {
            names.remove(name)
        }
        self.collapsedSessionGroups = names.sorted().joined(separator: "\u{1F}")
    }
}
#endif
