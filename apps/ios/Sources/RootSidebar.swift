import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct RootSidebar: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: RootSidebarModel
    @State private var scrollAnchor = RootSidebarScrollAnchor()
    @State private var searchText = ""
    @State private var collapsedParents: Set<String> = []
    @State private var isSearchActive = false
    @State private var presentedAttention: OpenClawChatAttentionPresentation?
    @FocusState private var isSearchFocused: Bool
    @AppStorage("sidebar.pinnedSessionsCollapsed") private var pinnedSessionsCollapsed = false
    @AppStorage("sidebar.sessionsCollapsed") private var sessionsCollapsed = false
    @AppStorage(RootTabs.pinnedSidebarPagesStorageKey) private var pinnedPagesStorage: String = ""

    let selectedDestination: RootTabs.SidebarDestination
    let isSidebarVisible: Bool
    let selectDestination: (RootTabs.SidebarDestination) -> Void
    let selectSession: (OpenClawChatSessionEntry) -> Void
    let openPagesEditor: () -> Void
    var drawerFooterBottomInset: CGFloat = 0

    var body: some View {
        let categories = self.sessionCategories
        let sessionSections = self.visibleSessionSections(categories: categories)
        let sessionLayout = Self.sessionLayout(sessionSections)
        let sidebarSessionKeys = Set(Self.flattened(sessionSections.flatMap(\.nodes)).map(\.session.key))
        let actualSessionKeys = Set(self.model.sessions.map(\.key))
        let showsAllSessions = sidebarSessionKeys.intersection(actualSessionKeys).count >= 15
        let rowPass = SessionRowPass(
            selectedSessionKey: resolvedSelectedSessionKey,
            mainSessionKey: resolvedMainSessionKey,
            categories: categories,
            approvals: self.appModel.pendingApprovalAttentionRequests)
        ScrollView {
            // Keep sections mounted when the keyboard pushes a row with a presented menu out of view.
            VStack(alignment: .leading, spacing: 16) {
                self.pagesSection(approvals: rowPass.approvals)
                    .padding(.top, 2)
                if !sessionLayout.pinnedNodes.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        self.sessionSectionHeader(
                            String(localized: "Pinned"),
                            isCollapsed: self.$pinnedSessionsCollapsed,
                            id: "RootTabs.Sidebar.PinnedSection")
                        if !self.pinnedSessionsCollapsed {
                            ForEach(self.displayRows(sessionLayout.pinnedNodes)) { row in
                                self.sessionTreeRow(row, rowPass: rowPass)
                            }
                        }
                    }
                }
                self.sessionsSection(
                    sections: sessionLayout.sections,
                    hasPinnedSessions: !sessionLayout.pinnedNodes.isEmpty,
                    showsAllSessions: showsAllSessions,
                    rowPass: rowPass)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .animation(self.reduceMotion ? nil : .easeInOut(duration: 0.2), value: sessionLayout.pinnedNodes.map(\.id))
            .modifier(RootSidebarAnchoredContent(anchor: self.scrollAnchor))
        }
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaBar(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                self.agentHeader
                if self.isSearchActive {
                    self.searchField
                }
            }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // Search owns the screen while it is open; the footer would otherwise ride up with the keyboard.
            if !self.isSearchActive {
                self.footer.padding(.bottom, self.drawerFooterBottomInset)
            }
        }
        .task(id: self.appModel.chatViewModelIdentityID) {
            await self.appModel.sessionGroups.refresh(appModel: self.appModel)
        }
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(OpenClawSidebarPalette.background)
        .onChange(of: self.isSidebarVisible) { _, isVisible in
            if !isVisible {
                self.presentedAttention = nil
                self.isSearchFocused = false
            }
        }
    }

    private var pinnedPages: [RootTabs.SidebarDestination] {
        RootTabs.pinnedSidebarPages(from: self.pinnedPagesStorage)
            .filter { $0 != .desktop || self.appModel.isDesktopObserveAvailable }
    }

    private var agentHeader: some View {
        HStack(spacing: 8) {
            // Until the first roster answer there is no agent to name; a placeholder word would swap.
            if let selectedAgent = self.selectedAgent {
                self.agentIdentity(selectedAgent)
                self.attentionBadges(for: self.model.sessions, targetID: "agent:\(selectedAgent.id)")
            }
            Spacer(minLength: 0)
            self.headerIconButton(
                systemName: "magnifyingglass",
                label: String(localized: "Search sessions"))
            {
                withAnimation(.easeInOut(duration: 0.15)) {
                    self.isSearchActive.toggle()
                }
                if self.isSearchActive {
                    self.isSearchFocused = true
                } else {
                    self.searchText = ""
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func agentIdentity(_ selectedAgent: AgentSummary) -> some View {
        if self.selectableAgents.count > 1 {
            Menu {
                Picker(selection: Binding(
                    get: { selectedAgent.id },
                    set: { self.appModel.setSelectedAgentId($0) }))
                {
                    ForEach(self.selectableAgents, id: \.id) { agent in
                        Label {
                            Text(verbatim: AgentIdentityPresentation.displayName(for: agent))
                                .font(OpenClawType.subheadSemiBold)
                        } icon: {
                            self.agentMenuAvatarImage(agent)
                                .renderingMode(.original)
                        }
                        .tag(agent.id)
                    }
                } label: {
                    Text(String(localized: "Agent"))
                        .font(OpenClawType.subheadSemiBold)
                }
                .pickerStyle(.inline)
            } label: {
                self.agentSelectorLabel(selectedAgent, showsPicker: true)
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .accessibilityIdentifier("RootTabs.Sidebar.AgentSelector")
            .accessibilityLabel(String(localized: "Agent"))
            .accessibilityValue(AgentIdentityPresentation.displayName(for: selectedAgent))
        } else {
            self.agentSelectorLabel(selectedAgent, showsPicker: false)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("RootTabs.Sidebar.AgentIdentity")
        }
    }

    private var selectableAgents: [AgentSummary] {
        self.appModel.displayAgents
    }

    private var selectedAgent: AgentSummary? {
        self.selectableAgents.first(where: { $0.id == self.currentAgentID })
    }

    private func agentSelectorLabel(_ agent: AgentSummary, showsPicker: Bool) -> some View {
        HStack(spacing: 9) {
            self.agentAvatarBadge(agent, size: 36)
            Text(verbatim: AgentIdentityPresentation.displayName(for: agent))
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .lineLimit(1)
            if showsPicker {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var newChatButton: some View {
        Button {
            self.appModel.requestNewChat()
            self.selectSidebarDestination(.chat)
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    RootSidebarIcon(systemName: "plus")
                    Text(String(localized: "New Chat"))
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                }
                .padding(.horizontal, 12)
                .fixedSize(horizontal: true, vertical: false)

                RootSidebarIcon(systemName: "plus")
                    .frame(width: 44)
            }
            .frame(minHeight: 44)
            .foregroundStyle(OpenClawSidebarPalette.textStrong)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Capsule())
        .disabled(!self.appModel.isOperatorGatewayConnected)
        .accessibilityLabel(String(localized: "New Chat"))
    }

    private func headerIconButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            RootSidebarIcon(systemName: systemName)
                .rootSidebarGlassCircle()
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .accessibilityLabel(label)
    }

    private var currentAgentID: String {
        let selected = self.appModel.selectedAgentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !selected.isEmpty {
            return selected
        }
        // A cold start draws the sidebar before the routing identity restores the default agent.
        return self.appModel.gatewayDefaultAgentId?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? self.appModel.cachedAgentIdentities.defaultAgentID ?? ""
    }

    private func agentAvatarBadge(_ agent: AgentSummary, size: CGFloat) -> some View {
        ZStack {
            if let image = self.appModel.agentAvatarImage(for: agent.id) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Circle()
                    .fill(OpenClawSidebarPalette.elevated)
                    .overlay(Circle().strokeBorder(OpenClawSidebarPalette.hairline, lineWidth: 1))
                // Initials only once the portrait is known to be missing, so they never flash before it.
                if self.appModel.knowsAgentAvatar(for: agent.id) {
                    Text(verbatim: AgentIdentityPresentation.badge(
                        avatarText: agent.identity?["emoji"]?.value as? String,
                        displayName: AgentIdentityPresentation.displayName(for: agent)))
                        .font(OpenClawType.caption2Bold)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .minimumScaleFactor(0.65)
                        .lineLimit(1)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private func agentMenuAvatarImage(_ agent: AgentSummary) -> Image {
        let renderer = ImageRenderer(content: agentAvatarBadge(agent, size: 24)
            .environment(\.colorScheme, self.colorScheme))
        renderer.scale = self.displayScale
        guard let image = renderer.uiImage else {
            return Image(systemName: "person.crop.circle")
        }
        return Image(uiImage: image)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityHidden(true)
            ZStack(alignment: .leading) {
                if self.searchText.isEmpty {
                    Text(String(localized: "Search sessions"))
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .accessibilityHidden(true)
                }
                TextField("", text: self.$searchText)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused(self.$isSearchFocused)
                    .accessibilityLabel(String(localized: "Search sessions"))
            }
            if !self.searchText.isEmpty {
                Button {
                    self.searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Clear session search"))
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .background(OpenClawSidebarPalette.elevated, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    private func sessionsSection(
        sections: [ChatSessionSidebarModel.Section],
        hasPinnedSessions: Bool,
        showsAllSessions: Bool,
        rowPass: SessionRowPass) -> some View
    {
        VStack(alignment: .leading, spacing: 4) {
            if let failure = self.appModel.sessionGroups.failure {
                Text(verbatim: failure).font(OpenClawType.captionMedium).foregroundStyle(OpenClawBrand.warn)
            }
            if let sessionErrorText = self.model.sessionErrorText {
                // The notice says "Try again", so the sidebar offers it: the same reload as the Sessions screen.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: sessionErrorText)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawBrand.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        Task { await self.model.refreshSessions(appModel: self.appModel) }
                    } label: {
                        Text(String(localized: "Try again"))
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(OpenClawSidebarPalette.textStrong)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(self.model.isRefreshing)
                    .accessibilityIdentifier("RootTabs.Sidebar.SessionsRetry")
                }
                .padding(.horizontal, 10)
            }
            HStack(spacing: 0) {
                self.sessionSectionHeader(
                    String(localized: "Sessions"),
                    isCollapsed: self.$sessionsCollapsed,
                    id: "RootTabs.Sidebar.SessionsSection")
                self.attentionBadges(
                    for: Self.flattened(sections.flatMap(\.nodes)).map(\.session),
                    targetID: "section:recent")
            }
            if !self.sessionsCollapsed {
                let rows = self.sessionRows(in: sections)
                if self.model.isRefreshing, self.model.sessions.isEmpty {
                    HStack(spacing: 9) {
                        ProgressView().controlSize(.small)
                        Text(String(localized: "Loading sessions"))
                            .font(OpenClawType.captionMedium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                    }
                    .frame(minHeight: 44)
                    .padding(.horizontal, 10)
                } else if rows.isEmpty, !hasPinnedSessions {
                    Text(String(localized: "No sessions"))
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 10)
                } else {
                    ForEach(rows) { row in
                        self.sessionTreeRow(row, rowPass: rowPass)
                    }
                }

                if showsAllSessions {
                    Button {
                        self.selectSidebarDestination(.sessions)
                    } label: {
                        HStack(spacing: 5) {
                            Text(String(localized: "View all"))
                                .font(OpenClawType.subheadMedium)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .accessibilityHidden(true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .accessibilityIdentifier("RootTabs.Sidebar.ViewAllSessions")
                }
            }
        }
    }

    private func pagesSection(approvals: [OpenClawChatAttentionRequest]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            self.homeRow(approvals: approvals)
            ForEach(self.pinnedPages) { destination in
                self.destinationButton(destination)
            }
            self.morePagesButton
        }
    }

    private var morePagesButton: some View {
        Button(action: self.showPagesEditor) {
            HStack(spacing: 10) {
                RootSidebarIcon(systemName: "square.grid.2x2")
                    .foregroundStyle(OpenClawSidebarPalette.text.opacity(0.82))
                Text(String(localized: "More"))
                    .font(OpenClawType.subheadMedium)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .accessibilityIdentifier("RootTabs.Sidebar.MorePages")
    }

    private func showPagesEditor() {
        self.openPagesEditor()
    }

    private var editPagesAction: some View {
        Button(action: self.showPagesEditor) {
            Label {
                Text(String(localized: "Edit Pages"))
                    .font(OpenClawType.subhead)
            } icon: {
                Image(systemName: "pencil")
            }
        }
    }

    /// The fixed first row opens the agent's main chat and carries its run/unread state.
    private func homeRow(approvals: [OpenClawChatAttentionRequest]) -> some View {
        let mainKey = self.resolvedMainSessionKey
        let needsApproval = self.needsApproval(mainKey, agentID: self.appModel.chatAgentId, in: approvals)
        let isSelected = self.selectedDestination == .chat &&
            self.resolvedSelectedSessionKey.caseInsensitiveCompare(mainKey) == .orderedSame
        let mainSession = self.mainSessionEntry
        let mark = SessionRowActivityMark(session: mainSession)
        return HStack(spacing: 0) {
            Button {
                self.appModel.openChat(sessionKey: mainKey)
                self.selectSidebarDestination(.chat)
            } label: {
                HStack(spacing: 10) {
                    // One bubble for the one main chat; Sessions, the plural, has two.
                    RootSidebarIcon(systemName: "bubble.left", pointSize: 16)
                        .foregroundStyle(OpenClawSidebarPalette.text.opacity(0.82))
                    Text(String(localized: "Main chat"))
                        .font(OpenClawType.subheadMedium)
                        .lineLimit(1)
                        .modifier(RootSidebarApprovalLabel(isVisible: needsApproval))
                    SessionRowActivityIndicator(mark: mark)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawSidebarPalette.text)
            .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
                cornerRadius: OpenClawProMetric.controlRadius,
                style: .continuous))
            .accessibilityIdentifier("RootTabs.Sidebar.Destination.chat")
            .overlay(alignment: .leading) {
                OpenClawSessionColorStripe(color: mainSession?.color)
            }
            .accessibilityValue(Self.sessionAccessibilityValue(
                isPinned: false,
                isUnread: mainSession?.unread == true,
                isWorking: mark == .working,
                needsApproval: needsApproval))
            .contextMenu { self.editPagesAction }
            .tint(.primary)
            self.attentionBadges(for: mainSession.map { [$0] } ?? [], targetID: "home")
        }
    }

    private var footer: some View {
        let isGatewaySelected = self.selectedDestination == .gateway
        let isSettingsSelected = self.selectedDestination == .settings
        return GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                self.headerIconButton(
                    systemName: "gearshape",
                    label: String(localized: "Settings"))
                {
                    self.selectSidebarDestination(.settings)
                }
                .background(
                    isSettingsSelected ? OpenClawSidebarPalette.selection : Color.clear,
                    in: RoundedRectangle(
                        cornerRadius: OpenClawProMetric.controlRadius,
                        style: .continuous))
                .accessibilityIdentifier("RootTabs.Sidebar.Destination.settings")
                .accessibilityAddTraits(isSettingsSelected ? .isSelected : [])

                RootSidebarGatewayControl(fallbackName: self.gatewayName) {
                    self.selectSidebarDestination(.gateway)
                }
                .background(isGatewaySelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
                    cornerRadius: OpenClawProMetric.controlRadius,
                    style: .continuous))
                .accessibilityAddTraits(isGatewaySelected ? .isSelected : [])

                Spacer(minLength: 4)

                self.newChatButton
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Alias-aware main lookup: rosters may return namespaced keys
    /// ("agent:<id>:main"), so raw comparison would drop Home's badges.
    private var mainSessionEntry: OpenClawChatSessionEntry? {
        self.model.sessions.first { $0.key == self.resolvedMainSessionKey }
    }

    private var resolvedMainSessionKey: String {
        self.model.resolvedSessionKey(
            current: "main",
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var resolvedSelectedSessionKey: String {
        self.model.resolvedSessionKey(
            current: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private func visibleSessionSections(categories: [String]) -> [ChatSessionSidebarModel.Section] {
        RootSidebarModel.sections(
            sessions: self.model.sessions,
            query: self.searchText,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            groups: categories.enumerated().map { offset, name in
                OpenClawChatSessionGroup(name: name, position: offset)
            },
            rosterIsComplete: self.model.isSessionRosterComplete,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract,
            now: self.model.now,
            personalPins: self.appModel.displayedSidebarPins)
    }

    struct SessionLayout: Equatable {
        let pinnedNodes: [ChatSessionSidebarModel.Node]
        let sections: [ChatSessionSidebarModel.Section]
    }

    static func sessionLayout(_ sections: [ChatSessionSidebarModel.Section]) -> SessionLayout {
        guard let pinnedIndex = sections.firstIndex(where: { $0.id == "pinned" }) else {
            return SessionLayout(pinnedNodes: [], sections: sections)
        }
        var remainingSections = sections
        let pinnedSection = remainingSections.remove(at: pinnedIndex)
        return SessionLayout(
            pinnedNodes: pinnedSection.nodes,
            sections: remainingSections)
    }

    private var sessionCategories: [String] {
        self.appModel.sessionGroups.names(for: self.model.sessions)
    }

    private static func flattened(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Node] {
        nodes.flatMap { [$0] + self.flattened($0.children) }
    }

    private func sessionRows(in sections: [ChatSessionSidebarModel.Section]) -> [ChatSessionSidebarModel.Row] {
        let nodes = sections.flatMap(\.nodes)
        guard let limit = Self.recentSessionCap(searchText: self.searchText) else {
            return self.displayRows(nodes)
        }
        let recent = nodes.sorted { ($0.session.updatedAt ?? 0) > ($1.session.updatedAt ?? 0) }
        return Array(self.displayRows(recent).prefix(limit))
    }

    static func recentSessionCap(searchText: String) -> Int? {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 15 : nil
    }

    /// Value inputs are shared within one render pass, never retained across a state change.
    private struct SessionRowPass {
        let selectedSessionKey: String
        let mainSessionKey: String
        let categories: [String]
        let approvals: [OpenClawChatAttentionRequest]
    }

    private func displayRows(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Row] {
        ChatSessionSidebarModel.rows(nodes) { node in
            !self.searchText.isEmpty || !self.collapsedParents.contains(node.id)
        }
    }

    private func sessionTreeRow(
        _ row: ChatSessionSidebarModel.Row,
        rowPass: SessionRowPass) -> some View
    {
        HStack(spacing: 0) {
            self.sessionButton(row.node, rowPass: rowPass)
            if !row.node.children.isEmpty {
                Button {
                    if !self.collapsedParents.insert(row.id).inserted {
                        self.collapsedParents.remove(row.id)
                    }
                } label: {
                    Image(systemName: self.collapsedParents.contains(row.id) ? "chevron.right" : "chevron.down")
                        .font(OpenClawType.captionSemiBold)
                        .frame(width: 32, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(self.collapsedParents.contains(row.id)
                    ? String(localized: "Show Sub-sessions") : String(localized: "Hide Sub-sessions"))
            }
        }
        .padding(.leading, CGFloat(row.depth) * 12)
        .modifier(RootSidebarAnchoredRow(id: row.id, anchor: self.scrollAnchor))
    }

    private func sessionButton(
        _ node: ChatSessionSidebarModel.Node,
        rowPass: SessionRowPass) -> some View
    {
        let session = node.session
        let isSelected = session.key == rowPass.selectedSessionKey
        return HStack(spacing: 0) {
            RootSidebarSessionButton(
                node: node,
                isSelected: isSelected,
                mainSessionKey: rowPass.mainSessionKey,
                categories: rowPass.categories,
                isConnected: self.appModel.isOperatorGatewayConnected,
                needsApproval: self.needsApproval(
                    session.key, agentID: session.agentId ?? self.appModel.chatAgentId, in: rowPass.approvals),
                open: self.selectSession,
                performMutation: self.performSessionMutation,
                fork: self.forkSession)
                .equatable()
            self.attentionBadges(for: Self.flattened([node]).map(\.session), targetID: "session:\(session.key)")
        }
    }

    private func needsApproval(
        _ sessionKey: String,
        agentID: String?,
        in approvals: [OpenClawChatAttentionRequest]) -> Bool
    {
        approvals.contains { request in
            self.appModel.approvalTargetsSession(
                sourceSessionKey: request.sessionKey,
                sourceAgentID: request.agentID,
                sessionKey: sessionKey,
                agentID: agentID)
        }
    }

    private func attentionBadges(for sessions: [OpenClawChatSessionEntry], targetID: String) -> some View {
        let questions = self.appModel.chatPresentation.isCurrent(appModel: self.appModel)
            ? self.appModel.chatPresentation.viewModel?.pendingQuestionAttentionRequests ?? []
            : []
        let scopedSessions = sessions.filter {
            ChatSessionSidebarModel.isSessionInActiveAgentScope(
                key: $0.key, agentID: $0.agentId, activeAgentID: self.appModel.chatAgentId)
        }
        let summary = ChatSessionSidebarModel.attentionSummary(
            requests: questions,
            sessions: scopedSessions,
            mainSessionKey: self.resolvedMainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
        return HStack(spacing: 0) {
            if let summary {
                OpenClawChatAttentionBadge(
                    summary: summary, targetID: targetID, presentation: self.$presentedAttention)
            }
        }
    }

    static func sessionAccessibilityValue(
        isPinned: Bool,
        isUnread: Bool,
        isWorking: Bool = false,
        needsApproval: Bool = false) -> String
    {
        var states: [String] = []
        if needsApproval {
            states.append(String(localized: "Needs approval"))
        }
        if isWorking {
            states.append(SessionListGroup.working.title)
        }
        if isPinned {
            states.append(String(localized: "Pinned"))
        }
        if isUnread {
            states.append(String(localized: "Unread"))
        }
        return states.joined(separator: ", ")
    }

    private func destinationButton(_ destination: RootTabs.SidebarDestination) -> some View {
        let isSelected = destination == self.selectedDestination
        let needsAttention = destination == .cron &&
            (self.model.failedCronJobCount > 0 || self.model.overdueCronJobCount > 0)
        return Button {
            self.selectSidebarDestination(destination)
        } label: {
            HStack(spacing: 10) {
                RootSidebarIcon(
                    systemName: RootSidebarIcon.symbolName(for: destination),
                    pointSize: RootSidebarIcon.pagePointSize(for: destination))
                    .foregroundStyle(OpenClawSidebarPalette.text.opacity(0.82))
                    .overlay(alignment: .topTrailing) {
                        if needsAttention {
                            Circle()
                                .fill(OpenClawSidebarPalette.accent)
                                .frame(width: 6, height: 6)
                                .offset(x: 1, y: -1)
                                .accessibilityHidden(true)
                        }
                    }
                Text(destination.sidebarTitle)
                    .font(OpenClawType.subheadMedium)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .accessibilityIdentifier("RootTabs.Sidebar.Destination.\(destination.rawValue)")
        .accessibilityValue(needsAttention ? String(localized: "Attention") : "")
        .contextMenu { self.editPagesAction }
        .tint(.primary)
    }

    private func sessionSectionHeader(
        _ title: String,
        isCollapsed: Binding<Bool>,
        id: String) -> some View
    {
        SessionSectionHeader(title: title, isCollapsed: isCollapsed, id: id)
    }

    private var gatewayName: String {
        Self.gatewayName(
            serverName: self.appModel.gatewayServerName,
            remoteAddress: self.appModel.gatewayRemoteAddress)
    }

    static func gatewayName(serverName: String?, remoteAddress: String?) -> String {
        for candidate in [serverName, remoteAddress] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return String(localized: "Connection")
    }

    private func performSessionMutation(
        resetActiveSessionKey: String?,
        _ operation: @escaping CommandSessionActionsModifier.Mutation)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if resetActiveSessionKey == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(
                    parentKey: session.key,
                    fromLastCompleted: session.hasActiveRun == true)
                self.appModel.openChat(sessionKey: key)
                self.selectSidebarDestination(.chat)
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func selectSidebarDestination(_ destination: RootTabs.SidebarDestination) {
        self.isSearchFocused = false
        self.selectDestination(destination)
    }
}

/// Shared Pages editor for the sidebar and Settings.
struct RootSidebarPagesEditor: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage(RootTabs.pinnedSidebarPagesStorageKey) private var pinnedPagesStorage: String = ""

    let onSelect: (RootTabs.SidebarDestination) -> Void
    var presentedAsSheet = true

    private var pinnedPages: [RootTabs.SidebarDestination] {
        RootTabs.pinnedSidebarPages(from: self.pinnedPagesStorage)
    }

    var body: some View {
        if self.presentedAsSheet {
            NavigationStack {
                self.pageList
                    .toolbar {
                        OpenClawSheetCloseItem { self.dismiss() }
                    }
            }
            .tint(.primary)
            .openClawSheetHeaderEdge()
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            // Below full height iOS draws the sheet as glass and the grouped rows turn a
            // translucent gray; at full height it switches to the opaque grouped background with
            // white rows. One opaque grouped background keeps the rows the same at every height.
            .presentationBackground(Color(uiColor: .systemGroupedBackground))
        } else {
            self.pageList
                .tint(.primary)
        }
    }

    private var pageList: some View {
        List {
            ForEach(RootTabs.pinnableSidebarPages
                .filter { $0 != .desktop || self.appModel.isDesktopObserveAvailable })
            { destination in
                self.pageRow(destination)
                    .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 8))
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, 4, for: .scrollContent)
        .navigationTitle(String(localized: "Pages"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func togglePinnedPage(_ destination: RootTabs.SidebarDestination) {
        var pages = self.pinnedPages
        if let index = pages.firstIndex(of: destination) {
            pages.remove(at: index)
        } else {
            pages.append(destination)
        }
        self.pinnedPagesStorage = RootTabs.pinnedSidebarPagesStorage(pages)
    }

    private func pageRow(_ destination: RootTabs.SidebarDestination) -> some View {
        let isPinned = self.pinnedPages.contains(destination)
        return HStack(spacing: 10) {
            Button {
                self.onSelect(destination)
            } label: {
                Label {
                    Text(destination.sidebarTitle)
                        .font(SettingsType.label)
                } icon: {
                    NativeSettingsRowIcon(systemName: RootSidebarIcon.symbolName(for: destination))
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                self.togglePinnedPage(destination)
            } label: {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(SettingsType.label)
                    .foregroundStyle(isPinned ? OpenClawSidebarPalette.text : OpenClawSidebarPalette.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(destination.sidebarTitle)
            .accessibilityValue(
                isPinned
                    ? String(localized: "Pinned")
                    : String(localized: "Not pinned"))
        }
    }
}

extension View {
    func rootSidebarGlassCircle() -> some View {
        self.frame(width: 44, height: 44)
            .contentShape(Circle())
            .glassEffect(.regular.interactive(), in: Circle())
    }
}

/// One optical size for navigation and session glyphs in the sidebar.
struct RootSidebarIcon: View {
    let systemName: String
    var pointSize: CGFloat = 18

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: self.pointSize, weight: .medium))
            .symbolRenderingMode(.monochrome)
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
    }

    /// A session's mark in search results and on the Sessions page.
    static let sessionSymbol = "bubble.left"

    /// The muted 15 pt mark that leads a list row in search and on the Sessions page.
    static func listMark(systemName: String) -> some View {
        RootSidebarIcon(systemName: systemName, pointSize: 15)
            .foregroundStyle(OpenClawSidebarPalette.muted)
    }

    static func pagePointSize(for destination: RootTabs.SidebarDestination) -> CGFloat {
        switch destination {
        case .usage, .cron: 19
        default: 16
        }
    }

    static func symbolName(for destination: RootTabs.SidebarDestination) -> String {
        switch destination {
        case .files: "folder"
        default: destination.systemImage
        }
    }
}
