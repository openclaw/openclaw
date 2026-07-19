import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct RootSidebar: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.displayScale) private var displayScale
    @Bindable var model: RootSidebarModel
    @State private var searchText = ""
    @State private var isSearchActive = false
    @State private var showsPagesEditor = false
    @FocusState private var isSearchFocused: Bool
    @AppStorage("sidebar.pinnedPages") private var pinnedPagesStorage: String = ""

    let selectedDestination: RootTabs.SidebarDestination
    let isDrawerLayout: Bool
    let selectDestination: (RootTabs.SidebarDestination) -> Void
    let selectSettingsRoute: (SettingsRoute) -> Void
    let hideSidebar: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            self.agentHeader
            if self.isSearchActive {
                self.searchField
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    self.pagesSection
                    self.sessionsSection
                    self.attentionSection
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 12)
            }
            self.footer
        }
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(OpenClawSidebarPalette.background)
        .environment(\.colorScheme, .dark)
        .sheet(isPresented: self.$showsPagesEditor) {
            RootSidebarPagesEditor(
                pinnedPages: self.pinnedPages,
                onSelect: { destination in
                    self.showsPagesEditor = false
                    self.selectDestination(destination)
                },
                onTogglePin: self.togglePinnedPage)
        }
        .task(id: self.refreshID) {
            guard self.scenePhase == .active else { return }
            await self.model.refresh(appModel: self.appModel)
        }
    }

    private var pinnedPages: [RootTabs.SidebarDestination] {
        RootTabs.pinnedSidebarPages(from: self.pinnedPagesStorage)
    }

    private func togglePinnedPage(_ destination: RootTabs.SidebarDestination) {
        var pages = self.pinnedPages
        if let index = pages.firstIndex(of: destination) {
            pages.remove(at: index)
        } else {
            pages = RootTabs.pinnableSidebarPages.filter { pages.contains($0) || $0 == destination }
        }
        self.pinnedPagesStorage = RootTabs.pinnedSidebarPagesStorage(pages)
    }

    private var refreshID: String {
        "\(self.appModel.chatViewModelIdentityID):\(self.scenePhase == .active)"
    }

    /// Web-parity agent card: current agent up top, switcher when the gateway
    /// offers more than one, compact icon actions on the trailing edge.
    private var agentHeader: some View {
        HStack(spacing: 8) {
            if self.appModel.gatewayAgents.count > 1 {
                Menu {
                    ForEach(self.appModel.gatewayAgents, id: \.id) { agent in
                        Button {
                            self.appModel.setSelectedAgentId(agent.id)
                        } label: {
                            if agent.id == self.currentAgentID {
                                Label {
                                    Text(verbatim: Self.agentDisplayName(agent))
                                        .font(OpenClawType.subheadSemiBold)
                                } icon: {
                                    Image(systemName: "checkmark")
                                }
                            } else {
                                Text(verbatim: Self.agentDisplayName(agent))
                                    .font(OpenClawType.subheadSemiBold)
                            }
                        }
                    }
                } label: {
                    self.agentCard(showsChevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Switch agent"))
            } else {
                self.agentCard(showsChevron: false)
            }

            Spacer(minLength: 4)

            self.headerIconButton(
                systemName: "plus.bubble",
                label: String(localized: "New Chat"))
            {
                self.appModel.requestNewChat()
                self.selectDestination(.chat)
            }
            .disabled(!self.appModel.isOperatorGatewayConnected)

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

            if self.isDrawerLayout {
                Button(action: self.hideSidebar) {
                    Image(systemName: "xmark")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.accent)
                .accessibilityLabel(String(localized: "Hide Sidebar"))
                .accessibilityIdentifier(RootTabs.sidebarHideButtonAccessibilityIdentifier)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 10)
        .background(OpenClawSidebarPalette.background)
        .overlay(alignment: .bottom) { self.separator }
    }

    private func agentCard(showsChevron: Bool) -> some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(OpenClawSidebarPalette.elevated)
                Text(verbatim: self.currentAgentBadge)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
            }
            .frame(width: 30, height: 30)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(verbatim: self.currentAgentName)
                        .font(OpenClawType.headline)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    if showsChevron {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .accessibilityHidden(true)
                    }
                }
                HStack(spacing: 5) {
                    Circle()
                        .fill(self.gatewayStatusColor)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Text(self.gatewayStatusTitle)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
    }

    private func headerIconButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemName)
                .font(OpenClawType.subheadSemiBold)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .accessibilityLabel(label)
    }

    private var currentAgentID: String {
        let selected = self.appModel.selectedAgentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !selected.isEmpty { return selected }
        return self.appModel.gatewayDefaultAgentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var currentAgent: AgentSummary? {
        let agents = self.appModel.gatewayAgents
        return agents.first { $0.id == self.currentAgentID } ?? agents.first
    }

    private var currentAgentName: String {
        if let currentAgent { return Self.agentDisplayName(currentAgent) }
        let active = self.appModel.activeAgentName.trimmingCharacters(in: .whitespacesAndNewlines)
        return active.isEmpty ? String(localized: "OpenClaw") : active
    }

    private var currentAgentBadge: String {
        Self.agentBadge(name: self.currentAgentName, identity: self.currentAgent?.identity)
    }

    static func agentDisplayName(_ agent: AgentSummary) -> String {
        let name = agent.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? agent.id : name
    }

    static func agentBadge(name: String, identity: [String: AnyCodable]?) -> String {
        if let emoji = (identity?["emoji"]?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !emoji.isEmpty
        {
            return emoji
        }
        let initials = name
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
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

    @ViewBuilder
    private var sessionsSection: some View {
        let sections = self.visibleSessionSections
        VStack(alignment: .leading, spacing: 6) {
            self.sectionTitle(String(localized: "Sessions"))
            if let sessionErrorText = self.model.sessionErrorText {
                Text(verbatim: sessionErrorText)
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
            }
            if self.model.isRefreshing, self.model.sessions.isEmpty {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text(String(localized: "Loading sessions"))
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .frame(minHeight: 44)
                .padding(.horizontal, 10)
            } else if sections.isEmpty {
                Text(String(localized: "No recent sessions"))
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
            } else {
                ForEach(sections) { section in
                    if let title = section.title {
                        Text(title)
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .padding(.horizontal, 10)
                            .padding(.top, 4)
                    }
                    ForEach(self.sessionNodes(for: section)) { node in
                        self.sessionButton(node)
                    }
                }
            }

            Button {
                self.selectDestination(.sessions)
            } label: {
                Label {
                    Text(String(localized: "All Sessions…"))
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "rectangle.stack")
                        .font(OpenClawType.subheadSemiBold)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawSidebarPalette.accent)
        }
    }

    private var pagesSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                self.sectionTitle(String(localized: "Pages"))
                Spacer(minLength: 4)
                Button {
                    self.showsPagesEditor = true
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(OpenClawType.captionSemiBold)
                        .frame(width: 40, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityLabel(String(localized: "Edit Pages"))
            }
            self.homeRow
            ForEach(self.pinnedPages) { destination in
                self.destinationButton(destination)
            }
        }
    }

    /// Fixed first Pages row like the web "Home": opens the agent's chat and
    /// carries the main session's run/unread state.
    private var homeRow: some View {
        let isSelected = self.selectedDestination == .chat
        let mainSession = self.model.sessions.first { $0.key == self.appModel.defaultChatSessionKey }
        return Button {
            self.selectDestination(.chat)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "house")
                    .font(OpenClawType.subheadSemiBold)
                    .frame(width: 18)
                Text(String(localized: "Home"))
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if mainSession?.hasActiveRun == true {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(OpenClawSidebarPalette.accent)
                } else if mainSession?.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? OpenClawSidebarPalette.accent : OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .accessibilityValue(mainSession?.unread == true ? String(localized: "Unread") : "")
    }

    @ViewBuilder
    private var attentionSection: some View {
        let approvalCount = self.appModel.pendingExecApprovalCount
        if approvalCount > 0 || self.model.hasCronAttention {
            VStack(alignment: .leading, spacing: 2) {
                self.sectionTitle(String(localized: "Attention"))
                if approvalCount > 0 {
                    self.attentionButton(
                        title: String(localized: "Pending approvals"),
                        value: approvalCount.formatted(),
                        systemImage: "checkmark.shield",
                        color: OpenClawBrand.warn)
                    {
                        self.selectSettingsRoute(.approvals)
                    }
                }
                if self.model.hasCronAttention {
                    self.attentionButton(
                        title: String(localized: "Automation issues"),
                        value: (self.model.failedCronJobCount + self.model.overdueCronJobCount).formatted(),
                        systemImage: "clock.badge.exclamationmark",
                        color: OpenClawBrand.warn)
                    {
                        self.selectDestination(.cron)
                    }
                }
            }
        }
    }

    /// Web-parity compact footer: connection state left, Settings gear right.
    private var footer: some View {
        VStack(spacing: 0) {
            self.separator
            HStack(spacing: 4) {
                Button {
                    self.selectDestination(.gateway)
                } label: {
                    HStack(spacing: 9) {
                        Circle()
                            .fill(self.gatewayStatusColor)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                        Text(verbatim: self.gatewayName)
                            .font(OpenClawType.subheadSemiBold)
                            .lineLimit(1)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.text)
                .accessibilityValue(self.gatewayStatusTitle)

                Spacer(minLength: 4)

                Button {
                    self.selectDestination(.settings)
                } label: {
                    Image(systemName: "gearshape")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.text)
                .accessibilityLabel(String(localized: "Settings"))
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .background(OpenClawSidebarPalette.background)
    }

    private var visibleSessionSections: [ChatSessionSidebarModel.Section] {
        self.model.sections(
            query: self.searchText,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId)
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(from: self.model.sessions, knownGroups: SessionGroupStore.load())
    }

    private func flattened(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Node] {
        nodes.flatMap { [$0] + self.flattened($0.children) }
    }

    private func sessionNodes(for section: ChatSessionSidebarModel.Section) -> [ChatSessionSidebarModel.Node] {
        let nodes = self.flattened(section.nodes)
        return section.id == "recent" ? Array(nodes.prefix(20)) : nodes
    }

    private func sessionButton(_ node: ChatSessionSidebarModel.Node) -> some View {
        let session = node.session
        let isSelected = session.key == self.appModel.chatSessionKey
        return Button {
            self.appModel.openChat(sessionKey: session.key, unread: session.unread == true)
            self.selectDestination(.chat)
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    if node.badges.runningCount > 0 {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(OpenClawSidebarPalette.accent)
                    } else {
                        Image(systemName: "bubble.left")
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(isSelected
                                ? OpenClawSidebarPalette.accent
                                : OpenClawSidebarPalette.muted)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CommandCenterTab.sessionTitle(session))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(isSelected
                            ? OpenClawSidebarPalette.accent
                            : OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    Text(verbatim: CommandCenterTab.sessionDetail(session))
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)
                if session.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.accent)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .commandSessionActions(
            session: session,
            categories: self.sessionCategories,
            isEnabled: self.appModel.isOperatorGatewayConnected,
            actions: CommandSessionActions(
                rename: { self.patchSession(session, label: .some($0)) },
                moveToGroup: { self.patchSession(session, category: .some($0)) },
                togglePinned: { self.patchSession(session, pinned: session.pinned != true) },
                toggleUnread: { self.patchSession(session, unread: session.unread != true) },
                fork: { self.forkSession(session) },
                toggleArchived: { self.patchSession(session, archived: true) },
                delete: { self.deleteSession(session) }))
        .accessibilityValue(session.unread == true ? String(localized: "Unread") : "")
    }

    private func destinationButton(_ destination: RootTabs.SidebarDestination) -> some View {
        let isSelected = destination == self.selectedDestination
        return Button {
            self.selectDestination(destination)
        } label: {
            Label {
                Text(destination.sidebarTitle)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
            } icon: {
                Image(systemName: destination.systemImage)
                    .font(OpenClawType.subheadSemiBold)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? OpenClawSidebarPalette.accent : OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
    }

    private func attentionButton(
        title: String,
        value: String,
        systemImage: String,
        color: Color,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: systemImage)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(color)
                    .frame(width: 18)
                Text(verbatim: title)
                    .font(OpenClawType.subheadSemiBold)
                Spacer(minLength: 6)
                Text(verbatim: value)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(color)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title.uppercased())
            .font(OpenClawType.caption2Bold)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .tracking(0.5)
            .padding(.horizontal, 10)
    }

    private var separator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(height: 1 / self.displayScale)
    }

    private var gatewayName: String {
        Self.gatewayName(
            serverName: self.appModel.gatewayServerName,
            remoteAddress: self.appModel.gatewayRemoteAddress)
    }

    static func gatewayName(serverName: String?, remoteAddress: String?) -> String {
        for candidate in [serverName, remoteAddress] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty { return trimmed }
        }
        return String(localized: "Connection")
    }

    private var gatewayStatusTitle: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Needs attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    private var gatewayStatusColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: OpenClawBrand.ok
        case .connecting: OpenClawBrand.accent
        case .error: OpenClawBrand.warn
        case .disconnected: OpenClawSidebarPalette.muted
        }
    }

    private func patchSession(
        _ session: OpenClawChatSessionEntry,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        Task {
            do {
                try await self.appModel.makeChatTransport().patchSession(
                    key: session.key,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                if archived == true, session.key == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func deleteSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                try await self.appModel.makeChatTransport().deleteSession(key: session.key)
                if session.key == self.appModel.chatSessionKey {
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
                let key = try await self.appModel.makeChatTransport().forkSession(parentKey: session.key)
                self.appModel.openChat(sessionKey: key)
                self.selectDestination(.chat)
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }
}

/// Web-parity Pages editor (the pen menu): navigate to any page, pin/unpin
/// which ones stay in the sidebar. Home is fixed and not listed.
struct RootSidebarPagesEditor: View {
    let pinnedPages: [RootTabs.SidebarDestination]
    let onSelect: (RootTabs.SidebarDestination) -> Void
    let onTogglePin: (RootTabs.SidebarDestination) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(RootTabs.pinnableSidebarPages) { destination in
                        self.pageRow(destination)
                    }
                } footer: {
                    Text("Pinned pages stay in the sidebar. Home is always shown.")
                        .font(OpenClawType.caption)
                }
            }
            .navigationTitle(String(localized: "Pages"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text(String(localized: "Done"))
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
        .openClawSheetChrome()
    }

    private func pageRow(_ destination: RootTabs.SidebarDestination) -> some View {
        let isPinned = self.pinnedPages.contains(destination)
        return HStack(spacing: 10) {
            Button {
                self.onSelect(destination)
            } label: {
                Label {
                    Text(destination.sidebarTitle)
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: destination.systemImage)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                self.onTogglePin(destination)
            } label: {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(isPinned ? OpenClawBrand.accent : Color.secondary)
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
