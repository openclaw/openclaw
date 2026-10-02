#if os(macOS)
import SwiftUI

extension ChatSessionSidebarModel.Node {
    var previewSessions: [OpenClawChatSessionEntry] {
        [self.session] + self.children.flatMap(\.previewSessions)
    }
}

private struct ChatSidebarOutlineNode: Identifiable {
    let node: ChatSessionSidebarModel.Node
    let ownerID: String?
    var id: String {
        self.node.id
    }

    var children: [Self]? {
        let nodes = ChatSessionSidebarModel.nodes(self.node.children, matchingOwner: self.ownerID)
        return nodes.isEmpty ? nil : nodes.map { Self(node: $0, ownerID: self.ownerID) }
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
    @State var menuPresentation: ChatSessionMenuPresentation?
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
    @Environment(\.openClawSidebarPeople) var sidebarPeople
    @State var isPresentingFilters = false
    @State var sectionOrder: [String] = []
    @AppStorage("openclaw.chat.sidebar.grouping") var sessionGrouping = ChatSessionSidebarModel.Grouping.category
    @AppStorage("openclaw.chat.sidebar.status") var sessionStatus = OpenClawChatSidebarStatus.active
    @AppStorage("openclaw.chat.sidebar.ownerFilter") var sessionOwnerFilter = ""
    @AppStorage("openclaw.chat.sidebar.emptyGroups") var emptyGroups = ChatSessionSidebarModel.EmptyGroups.filtering
    @State private var observedOrder = ChatSessionSidebarModel.ObservedOrder()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            self.sidebar(now: context.date)
        }
    }

    private func sidebar(now: Date) -> some View {
        let sections = self.rosterSections(observedOrder: self.observedOrder)
        let projectedRows = sections.flatMap(\.nodes).flatMap(\.previewSessions)
        let ownership = self.ownership(for: projectedRows)
        let previewRequest = ChatSessionSidebarPreviews.Request(
            viewModel: self.viewModel,
            sessions: projectedRows)
        return List(selection: self.selectionBinding) {
            self.newThreadButton
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 16, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            ChatSidebarOnlineSection(viewModel: self.viewModel)
            self.agentsSection(now: now)
            self.threadsHeading(ownership: ownership)
            ForEach(sections) { section in
                self.sessionSection(section, now: now, ownership: ownership, previewRequest: previewRequest)
            }
            if let data = self.rosterData { ChatSessionSidebarRosterState(data: data) }
            if sections.allSatisfy(\.nodes.isEmpty), self.rosterData?.isSettled != false {
                Text(self.query
                    .isEmpty ? (self.sessionStatus == .archived ? String(localized: "No archived threads") :
                        String(localized: "No threads yet")) : String(localized: "No matching threads"))
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
        .onChange(of: (self.rosterData?.rows ?? self.viewModel.sessions).map(\.key), initial: true) { _, keys in
            self.observedOrder.observe(keys)
        }
        .onChange(of: self.query, initial: true) { _, value in
            self.viewModel.updateSidebarQuery(
                search: value, showAutomation: self.showAutomationSessions, showSystem: self.showSystemSessions)
        }
        .onChange(of: self.filterOptions, initial: true) { self.applySidebarFilters() }
        // Agent discovery can admit the roster after the first render; apply the profile's choices at admission.
        .onChange(of: self.rosterData.map(ObjectIdentifier.init)) { self.applySidebarFilters() }
        .onChange(of: self.rosterData?.owners, initial: true) { self.reconcileOwnerFacet() }
        .onChange(of: self.sidebarPeople?.selfKey) { self.reconcileOwnerFacet() }
        .onChange(of: self.viewModel.selectedAgentID) { self.applySidebarFilters() }
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
                try await self.loadSidebarGroups()
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
        .sheet(item: self.$menuPresentation) { self.menuSheet($0) }
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

    func rows(
        _ nodes: [ChatSessionSidebarModel.Node],
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        let rootIDs = Set(nodes.map(\.id))
        let outline = nodes.map { ChatSidebarOutlineNode(node: $0, ownerID: self.filterOptions.ownerID) }
        return OutlineGroup(outline, children: \.children) { item in
            self.row(
                for: item.node,
                isChild: !rootIDs.contains(item.id),
                now: now,
                ownership: ownership,
                previewRequest: previewRequest)
        }
    }

    func isGroupCollapsed(_ name: String) -> Bool {
        self.collapsedSessionGroups.split(separator: "\u{1F}").contains(Substring(name))
    }

    func toggleGroupCollapsed(_ name: String) {
        var names = Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init))
        if !names.insert(name).inserted {
            names.remove(name)
        }
        self.collapsedSessionGroups = names.sorted().joined(separator: "\u{1F}")
    }
}
#endif
