#if os(macOS)
import SwiftUI

extension ChatSessionSidebarModel.Node {
    var previewSessions: [OpenClawChatSessionEntry] {
        [self.session] + self.foldedSessions + self.children.flatMap(\.previewSessions)
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
    @State var agentSessionsTarget: OpenClawChatAgentChoice?
    @State var collapsedAgentIDs: Set<String> = []
    @State var agentReveal = ChatSidebarAgentReveal()
    @State var sidebarChildren = ChatSessionSidebarChildren()
    @State var childModes: [String: ChatSidebarChildMode] = [:]
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
    @State private var lastSnoozeWake = Date.distantPast

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            self.sidebar(now: max(context.date, self.lastSnoozeWake))
        }
    }

    private func sidebar(now: Date) -> some View {
        let sections = self.rosterSections(now: now, observedOrder: self.observedOrder)
        let nextWake = OpenClawChatSessionSnooze.nextWake(
            in: self.rosterData?.queryRows ?? self.viewModel.sessions, now: now)
        let projectedRows = sections.flatMap(\.nodes).flatMap(\.previewSessions)
        let ownership = self.ownership(for: projectedRows)
        let previewRequest = ChatSessionSidebarPreviews.Request(
            viewModel: self.viewModel,
            sessions: projectedRows)
        let hydration = self.hydrationRequest(sections)
        let selectedTreeSession = self.selectedTreeSession
        let selectedTreeID = ChatSessionSidebarChildren.key(for: selectedTreeSession)
        return List(selection: Self.selectionBinding(model: self.viewModel)) {
            self.newThreadButton
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 16, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            self.pagesSection(sections, now: now, ownership: ownership, previewRequest: previewRequest)
            ChatSidebarOnlineSection(viewModel: self.viewModel)
            self.agentScopePicker
            if !self.showsAllAgents || self.viewModel.agentChoices.isEmpty {
                self.agentsSection(now: now)
            }
            if !self.showsAgentRoster {
                ForEach(hydration.homeParents
                    .filter { !hydration.inlineParents.contains(ChatSessionSidebarChildren.key(for: $0)) })
                { parent in
                    self.childLoadState(parent)
                }
            }
            self.threadsHeading(ownership: ownership)
            if self.showsAgentRoster {
                self.agentRoster(sections, now: now, ownership: ownership, previewRequest: previewRequest)
            } else {
                ForEach(sections.filter { $0.id != "pinned" }) { section in
                    self.sessionSection(section, now: now, ownership: ownership, previewRequest: previewRequest)
                }
            }
            if let data = self.rosterData { ChatSessionSidebarRosterState(data: data) }
            if !hydration.inlineParents.contains(selectedTreeID),
               !hydration.homeParents.contains(where: { ChatSessionSidebarChildren.key(for: $0) == selectedTreeID })
            {
                self.childLoadState(selectedTreeSession)
            }
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
        .sidebarAgentAvatars(owner: self.viewModel.sidebarData, transport: self.viewModel.transport)
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
        .onChange(of: self.filterOptions, initial: true) { previous, current in
            if previous.sort != current.sort || previous.grouping != current.grouping || previous.status != current
                .status
            {
                self.agentReveal.members = [:]
            }
            self.applySidebarFilters()
        }
        // Agent discovery can admit the roster after the first render; apply the profile's choices at admission.
        .onChange(of: self.rosterData.map(ObjectIdentifier.init)) { self.childModes = [:]
            self.agentReveal.members = [:]
            self.restoreAgentPresentation()
            self.applySidebarFilters()
        }
        .onChange(of: self.rosterData?.owners, initial: true) { self.reconcileOwnerFacet() }
        .onChange(of: self.sidebarPeople?.selfKey) { self.reconcileOwnerFacet() }
        .onChange(of: self.sidebarGatewayID, initial: true) { self.restoreAgentPresentation() }
        .onChange(of: self.viewModel.selectedAgentID) {
            // ui/src/components/sidebar-projection-memo.ts:179 uses one "*" scope across roster navigation.
            if !self.showsAllAgents { self.childModes = [:] }
            self.applySidebarFilters()
        }
        .onChange(of: self.showsAllAgents) { self.childModes = [:]
            self.agentReveal.members = [:]
        }
        .onChange(of: self.viewModel.sidebarData?.scopeRevision) { self.childModes = [:]
            self.agentReveal.members = [:]
        }
        .task(id: hydration) {
            await self.sidebarChildren.synchronize(model: self.viewModel, requiredParents: hydration.parents)
        }
        .onDisappear { self.sidebarChildren.invalidate() }
        .task(id: previewRequest) {
            let model = self.viewModel
            let cache = model.transcriptCache
            await model.pendingCacheWriteTask?.value
            guard !Task.isCancelled, ObjectIdentifier(self.viewModel) == previewRequest.modelID else { return }
            await self.previews.refresh(previewRequest, cache: cache)
        }
        .task(id: nextWake) {
            guard let nextWake else { return }
            do {
                try await Task.sleep(for: .seconds(max(0, nextWake.timeIntervalSinceNow)))
                try Task.checkCancellation()
                self.lastSnoozeWake = max(nextWake, .now)
            } catch {}
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
        .sheet(item: self.$agentSessionsTarget) { ChatSessionsSheet(viewModel: self.viewModel, agentID: $0.id) }
        .sheet(item: self.$inspectedSession) { session in
            ChatSessionInspectorSheet(viewModel: self.viewModel, session: session)
        }
        .alert(
            String(localized: "Rename Thread"),
            isPresented: self.isPresentingRenameAlert)
        {
            self.renameActions
        }
        .confirmationDialog(self.deleteDialogTitle, isPresented: self.isPresentingDeleteDialog) {
                self.deleteAction
            } message: {
                Text(String(localized: "The thread and its transcript are removed from the gateway."))
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
    }

    private var deleteAction: some View {
        Button(String(localized: "Delete Thread"), role: .destructive) {
            if let session = self.sessionPendingDeletion {
                self.viewModel.deleteSession(session.key, agentID: session.agentId)
            }
            self.sessionPendingDeletion = nil
        }
    }

    @ViewBuilder private var renameActions: some View {
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

    static func selectionBinding(model: OpenClawChatViewModel) -> Binding<OpenClawChatSessionTarget?> {
        Binding(
            get: {
                let key = ChatSessionSidebarModel.selectedSessionKey(
                    sessions: model.sessions,
                    currentSessionKey: model.sessionKey,
                    mainSessionKey: model.selectedAgentMainSessionKey,
                    activeAgentID: model.selectedAgentID,
                    sessionRoutingContract: model.agentCatalog?.sessionRoutingContract ?? model.sessionRoutingContract)
                return ChatSessionSidebarModel.selectionTarget(
                    for: .init(key: key), fallbackAgentID: model.selectedAgentID)
            },
            set: { next in
                guard let next else { return }
                // List writes this binding inside its table selection delegate.
                // Navigation changes the same rows and focus, so leave that callback first.
                Task { @MainActor in
                    model.switchSession(to: next.sessionKey, agentID: next.agentID)
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
        ForEach(nodes) { node in
            self.treeRow(node, isChild: false, now: now, ownership: ownership, previewRequest: previewRequest)
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
