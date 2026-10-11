import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct RootSidebar: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @Bindable var model: RootSidebarModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @State private var showsAgentPicker = false
    @AppStorage("sidebar.pinnedAgents") private var pinnedAgentsStorage = ""
    @State private var dashboardRoute: RootSidebarDashboardRoute?
    @State private var showsNewGroup = false
    @State private var groupDraft = ""
    private struct BatchTarget {
        let rows: [OpenClawChatSessionEntry]
        let connection: OpenClawSessionMenuConnection
    }

    @State private var confirmsBatchDelete = false
    @State private var pendingBatchDelete: BatchTarget?
    @State private var archivedRows: [OpenClawChatSessionEntry] = []
    @State private var archiveConnection: OpenClawSessionMenuConnection?
    @State private var showsArchiveUndo = false
    @State private var selectingSessions = false
    @State private var selectedSessions: Set<String> = []
    @State private var searchText = ""
    @State private var isSearchActive = false
    @State private var showsPagesEditor = false
    @State private var showsOwnerFilter = false
    @State private var showsDiagnostics = false
    @State private var diagnosticsPath: [SettingsRoute] = [.diagnostics]
    @State private var expandedSessions: Set<String> = []
    @State private var presentedAttention: OpenClawChatAttentionPresentation?
    @FocusState private var isSearchFocused: Bool
    @AppStorage("sidebar.pinnedPages") private var pinnedPagesStorage: String = ""

    let selectedDestination: RootTabs.SidebarDestination
    let isDrawerLayout: Bool
    let isDismissButtonEnabled: Bool
    let selectDestination: (RootTabs.SidebarDestination) -> Void
    let selectSession: (OpenClawChatSessionEntry) -> Void
    let hideSidebar: () -> Void

    var body: some View {
        let sessionLayout = Self.sessionLayout(self.visibleSessionSections)
        VStack(spacing: 0) {
            self.brandHeader
            if self.isSearchActive {
                self.searchField
            }
            ScrollView {
                // One 10pt unit everywhere: side insets, section gaps, and
                // the picker card's clearance all match.
                // Not lazy: with three sections it saves nothing, and a lazy stack drops a section the
                // keyboard pushes out of view, which closes an alert or sheet opened from one of its rows.
                VStack(alignment: .leading, spacing: 10) {
                    self.agentsSection
                    self.pagesSection(pinnedSessionNodes: sessionLayout.pinnedNodes)
                    RootSidebarPeopleSection(
                        sessions: self.model.sessions,
                        isActive: self.isDismissButtonEnabled,
                        openSession: self.selectSession,
                        openActivity: { profileID, name in
                            if let path = OpenClawChatSidebarPeople.activityPath(for: profileID) {
                                self.dashboardRoute = .init(path: path, title: name)
                            }
                        })
                    self.sessionsSection(
                        sections: sessionLayout.sections,
                        hasPinnedSessions: !sessionLayout.pinnedNodes.isEmpty)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
            }
            self.footer
        }
        .task(id: self.appModel.chatViewModelIdentityID) {
            await self.appModel.sessionGroups.refresh(appModel: self.appModel)
        }
        .environment(\.commandSessionMenuConnection, self.appModel.sessionGroups.connection)
        .onChange(of: self.model.rosterQuery) { _, _ in
            Task { await self.model.refreshSessions(appModel: self.appModel) }
        }
        .onChange(of: self.model.viewOptions.showMessagePreview) { _, _ in
            Task { await self.model.refreshSessions(appModel: self.appModel) }
        }
        .onChange(of: self.model.showsAllAgents) { _, _ in
            Task { await self.model.refreshSessions(appModel: self.appModel) }
        }
        .sheet(isPresented: self.$showsAgentPicker) {
            RootSidebarAgentPicker(
                agents: self.selectableAgents,
                selectedID: self.selectedAgent?.id,
                pinnedIDs: Binding(
                    get: { Set(self.pinnedAgentsStorage.split(separator: ",").map(String.init)) },
                    set: { self.pinnedAgentsStorage = $0.sorted().joined(separator: ",") }),
                select: { id in
                    self.model.showsAllAgents = false
                    self.appModel.setSelectedAgentId(id)
                    self.showsAgentPicker = false
                },
                selectAll: { self.model.showsAllAgents = true
                    self.showsAgentPicker = false
                })
        }
        .sheet(item: self.$dashboardRoute) { route in
            DashboardPageScreen(
                path: route.path,
                title: route.title,
                queryItems: route.queryItems,
                onClose: { self.dashboardRoute = nil })
        }
        .sheet(isPresented: self.$showsNewGroup) {
            NavigationStack {
                Form {
                    TextField(text: self.$groupDraft) { Text("Group Name").font(OpenClawType.body) }
                        .font(OpenClawType.body)
                    if let error = self.appModel.sessionGroups.failure {
                        Text(verbatim: error).font(OpenClawType.body).foregroundStyle(OpenClawBrand.warn)
                    }
                }
                .navigationTitle(String(localized: "New Group"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { self.showsNewGroup = false } label: { Text("Cancel").font(OpenClawType.subhead) }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { self.createGroup() } label: { Text("Create").font(OpenClawType.subheadSemiBold) }
                            .disabled(self.groupDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                self.appModel.sessionGroups.submitting)
                    }
                }
            }.openClawSheetChrome()
        }
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(OpenClawSidebarPalette.background)
        .onChange(of: self.isDismissButtonEnabled) { _, isVisible in
            if !isVisible {
                self.presentedAttention = nil
                self.isSearchFocused = false
            }
        }
        .alert("Sessions Archived", isPresented: self.$showsArchiveUndo) {
            Button { self.undoArchive() } label: { Text("Undo").font(OpenClawType.subheadSemiBold) }
            Button(role: .cancel) { self.archivedRows = []
                self.archiveConnection = nil
            } label: {
                Text("Done").font(OpenClawType.subhead)
            }
        }
        .confirmationDialog("Delete Selected Sessions?", isPresented: self.$confirmsBatchDelete) {
            Button(role: .destructive) {
                guard let target = self.pendingBatchDelete else { return }
                self.pendingBatchDelete = nil
                self.performBatch("sessions.delete", target: target)
            } label: {
                Text("Delete Sessions").font(OpenClawType.subheadSemiBold)
            }
            Button(role: .cancel) { self.pendingBatchDelete = nil } label: {
                Text("Cancel").font(OpenClawType.subhead)
            }
        } message: {
            Text("This permanently deletes the selected sessions and their transcripts.").font(OpenClawType.body)
        }
        .sheet(isPresented: self.$showsDiagnostics) {
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button { self.showsDiagnostics = false } label: { Text("Done").font(OpenClawType.subheadSemiBold) }
                }.padding()
                SettingsHubScreen(navigationPath: self.$diagnosticsPath)
            }.openClawSheetChrome()
        }
        .sheet(isPresented: self.$showsOwnerFilter) {
            RootSidebarOwnerFilter(selection: self.$model.viewOptions.ownerFilter, owners: self.model.owners ?? [])
        }
        .sheet(isPresented: self.$showsPagesEditor) {
            RootSidebarPagesEditor(
                destinations: RootTabs.sidebarCustomizablePages.filter(self.isDestinationAvailable),
                pinnedPages: self.storedPinnedPages,
                onSelect: { destination in
                    self.showsPagesEditor = false
                    self.selectSidebarDestination(destination)
                },
                onTogglePin: self.togglePinnedPage,
                onReset: self.resetSidebar)
        }
    }

    private var sidebarEntries: [RootTabs.SidebarEntry] {
        Self.sessionLayout(self.visibleSessionSections).reconciledEntries(
            RootTabs.sidebarEntries(from: self.pinnedPagesStorage))
    }

    private func sidebarSessionKey(_ session: OpenClawChatSessionEntry) -> String {
        RootTabs.sidebarSessionSlot(for: session)
    }

    private func sessionMoveAction(_ session: OpenClawChatSessionEntry, offset: Int) -> (() -> Void)? {
        guard session.pinned == true else { return nil }
        let entry = RootTabs.SidebarEntry.session(self.sidebarSessionKey(session))
        let visible = self.visibleSidebarEntries
        guard let index = visible.firstIndex(of: entry), visible.indices.contains(index + offset) else { return nil }
        return { self.moveSidebarEntry(entry, by: offset) }
    }

    private var storedPinnedPages: [RootTabs.SidebarDestination] {
        self.sidebarEntries.compactMap {
            if case let .route(page) = $0 {
                page
            } else { nil }
        }
    }

    private var visibleSidebarEntries: [RootTabs.SidebarEntry] {
        let pinnedNodes = Self.sessionLayout(self.visibleSessionSections).pinnedNodes
        let sessionKeys = Set(pinnedNodes.map { self.sidebarSessionKey($0.session) })
        return self.sidebarEntries.filter { entry in
            switch entry {
            case let .route(page): self.isDestinationAvailable(page)
            case let .session(key): sessionKeys.contains(key)
            }
        }
    }

    private func isDestinationAvailable(_ destination: RootTabs.SidebarDestination) -> Bool {
        destination != .desktop || self.appModel.isDesktopObserveAvailable
    }

    private func togglePinnedPage(_ destination: RootTabs.SidebarDestination) {
        let entries = self.sidebarEntries
        self.pinnedPagesStorage = RootTabs.sidebarEntriesStorage(RootTabs.settingSidebarEntry(
            .route(destination), pinned: !entries.contains(.route(destination)), entries: entries))
    }

    private func resetSidebar() {
        self.pinnedPagesStorage = RootTabs.sidebarEntriesStorage(RootTabs.resetSidebarEntries(self.sidebarEntries))
    }

    private func moveSidebarEntry(_ entry: RootTabs.SidebarEntry, by offset: Int) {
        self.pinnedPagesStorage = RootTabs.sidebarEntriesStorage(RootTabs.movingSidebarEntry(
            entry, by: offset, entries: self.sidebarEntries, visibleEntries: self.visibleSidebarEntries))
    }

    /// Brand header with compact global actions. Connection and Settings live
    /// together in the footer so the header stays focused on navigation.
    private var brandHeader: some View {
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                // The shell keeps a hidden sidebar mounted; an unpaused mascot would redraw unseen.
                OpenClawProMark(size: 26, shadowRadius: 2, paused: !self.isDismissButtonEnabled)
                    .accessibilityHidden(true)
                Text(String(localized: "OpenClaw"))
                    .font(OpenClawType.headline)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
            .contextMenu { self.identityMenu }
            .padding(.leading, 6)

            Spacer(minLength: 4)

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
                OpenClawSidebarControlButton(action: self.dismissAction)
                    .allowsHitTesting(self.isDismissButtonEnabled)
                    .accessibilityHidden(!self.isDismissButtonEnabled)
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(OpenClawSidebarPalette.background)
        .overlay(alignment: .bottom) { self.separator }
    }

    private var dismissAction: OpenClawSidebarHeaderAction {
        OpenClawSidebarHeaderAction(
            systemName: "sidebar.leading",
            accessibilityLabel: .localized("Hide Sidebar"),
            accessibilityIdentifier: self.isDismissButtonEnabled
                ? RootTabs.sidebarHideButtonAccessibilityIdentifier
                : nil,
            action: self.dismissSidebar)
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
    private func sessionsSection(
        sections: [ChatSessionSidebarModel.Section],
        hasPinnedSessions: Bool) -> some View
    {
        let selectedSessionKey = self.resolvedSelectedSessionKey
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                self.sectionTitle(String(localized: "Sessions"))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .contextMenu { self.sessionViewMenu }
                    .accessibilityIdentifier("RootTabs.Sidebar.SessionViewMenu")
                    .accessibilityHint(String(localized: "Touch and hold for filters, sorting and session actions"))
                if self.selectingSessions {
                    Text(String(format: String(localized: "%lld Selected"), self.selectedSessions.count))
                        .font(OpenClawType.captionSemiBold)
                        .padding(8).contentShape(Rectangle())
                        .contextMenu { self.batchMenu }
                    Button { self.selectingSessions = false
                        self.selectedSessions = []
                    } label: {
                        Text("Done").font(OpenClawType.subheadSemiBold)
                    }
                }
            }

            if let failure = self.appModel.sessionGroups.failure {
                Text(verbatim: failure).font(OpenClawType.captionMedium).foregroundStyle(OpenClawBrand.warn)
            }
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
            } else if sections.isEmpty, !hasPinnedSessions {
                Text(String(localized: "No sessions"))
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
            } else {
                ForEach(sections) { section in
                    let title = section.id == "recent"
                        ? String(localized: "Sessions")
                        : (section.title ?? String(localized: "Sessions"))
                    if section.id.hasPrefix("group:"), let name = section.title {
                        CommandSessionGroupHeader(
                            name: name,
                            sessions: self.model.sessions,
                            trailingCount: section.nodes.count,
                            refresh: { await self.model.refreshSessions(appModel: self.appModel) },
                            openSession: { key in
                                self.appModel.openChat(sessionKey: key)
                                self.selectSidebarDestination(.chat)
                            },
                            accessory: {
                                self.attentionBadges(
                                    for: Self.flattened(section.nodes).map(\.session),
                                    targetID: "section:\(section.id)")
                            })
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            // Leading inset only: the caret and count sit at the trailing edge.
                            .padding(.leading, 10)
                    } else {
                        HStack(spacing: 0) {
                            self.sectionTitle(title)
                            Spacer(minLength: 0)
                            self.attentionBadges(
                                for: Self.flattened(section.nodes).map(\.session), targetID: "section:\(section.id)")
                        }
                    }
                    if !section.id.hasPrefix("group:") ||
                        !self.appModel.sessionGroups.collapsed.contains(section.title ?? "") || !self.searchText.isEmpty
                    {
                        ForEach(self.sessionRows(for: section)) { row in
                            self.sessionButton(row.node, selectedSessionKey: selectedSessionKey, depth: row.depth)
                        }
                    }
                }
            }

            Button {
                self.selectSidebarDestination(.sessions)
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

    private func pagesSection(pinnedSessionNodes: [ChatSessionSidebarModel.Node]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            self.sectionTitle(String(localized: "Pages"))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                .contextMenu {
                    Button { self.showsPagesEditor = true } label: {
                        Label("Edit Pages…", systemImage: "square.and.pencil").font(OpenClawType.subhead)
                    }
                    Button { self.resetSidebar() } label: {
                        Label("Reset Pages", systemImage: "arrow.counterclockwise").font(OpenClawType.subhead)
                    }
                }
                .accessibilityHint(String(localized: "Touch and hold to edit pages"))
            self.homeRow
            let selectedSessionKey = self.resolvedSelectedSessionKey
            ForEach(self.visibleSidebarEntries) { entry in
                switch entry {
                case let .route(destination):
                    self.destinationButton(destination)
                case let .session(key):
                    if let node = pinnedSessionNodes.first(where: { self.sidebarSessionKey($0.session) == key }) {
                        ForEach(self.rows([node])) { row in
                            self.sessionButton(row.node, selectedSessionKey: selectedSessionKey, depth: row.depth)
                        }
                    }
                }
            }
        }
    }

    /// Fixed first Pages row like the web "Home": opens the agent's chat and
    /// carries the main session's run/unread state.
    private var homeRow: some View {
        let mainKey = self.resolvedMainSessionKey
        let isSelected = self.selectedDestination == .chat &&
            self.resolvedSelectedSessionKey.caseInsensitiveCompare(mainKey) == .orderedSame
        let mainSession = self.mainSessionEntry
        return HStack(spacing: 0) {
            Button {
                self.appModel.openChat(sessionKey: mainKey)
                self.selectSidebarDestination(.chat)
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
            .commandSessionActions(
                session: mainSession ?? .init(key: mainKey, isMain: true),
                mainSessionKey: mainKey,
                categories: self.sessionCategories,
                isEnabled: mainSession != nil && self.appModel.isOperatorGatewayConnected,
                canArchive: false,
                canDelete: false,
                performMutation: self.performSessionMutation,
                fork: { if let mainSession { self.forkSession(mainSession) } })
            .environment(\.commandSessionMenuConnection, mainSession.flatMap { self.menuConnection(for: $0) })
            .accessibilityIdentifier("RootTabs.Sidebar.Destination.chat")
            .overlay(alignment: .leading) {
                OpenClawSessionColorStripe(color: mainSession?.color)
            }
            .accessibilityValue(mainSession?.unread == true ? String(localized: "Unread") : "")
            self.attentionBadges(for: mainSession.map { [$0] } ?? [], targetID: "home")
        }
    }

    /// Web-parity compact footer: connection state left, Settings gear right.
    private var footer: some View {
        VStack(spacing: 0) {
            self.separator
            HStack(spacing: 4) {
                RootSidebarGatewayControl(fallbackName: self.gatewayName) {
                    self.selectSidebarDestination(.gateway)
                }

                Spacer(minLength: 4)

                self.headerIconButton(
                    systemName: "gearshape",
                    label: String(localized: "Settings"))
                {
                    self.selectSidebarDestination(.settings)
                }
                .contextMenu { self.identityMenu }
                .accessibilityIdentifier("RootTabs.Sidebar.Destination.settings")
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .fixedSize(horizontal: false, vertical: true)
        .background(OpenClawSidebarPalette.background)
    }

    private func destinationButton(_ destination: RootTabs.SidebarDestination) -> some View {
        let isSelected = destination == self.selectedDestination
        let badgeCount = self.badgeCount(for: destination)
        return Button {
            self.selectSidebarDestination(destination)
        } label: {
            HStack(spacing: 0) {
                Label {
                    Text(destination.sidebarTitle)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                } icon: {
                    Image(systemName: destination.systemImage)
                        .font(OpenClawType.subheadSemiBold)
                }
                Spacer(minLength: 6)
                if badgeCount > 0 {
                    Text(verbatim: badgeCount.formatted())
                        .font(OpenClawType.caption2Bold)
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(OpenClawSidebarPalette.accent, in: Capsule())
                        .accessibilityLabel(String(localized: "Attention"))
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
        .contextMenu {
            Button { self.togglePinnedPage(destination) } label: {
                Label("Remove from Sidebar", systemImage: "pin.slash").font(OpenClawType.subhead)
            }
            Button { self.movePinnedPage(destination, by: -1) } label: {
                Label("Move Up", systemImage: "arrow.up").font(OpenClawType.subhead)
            }.disabled(self.visibleSidebarEntries.first == .route(destination))
            Button { self.movePinnedPage(destination, by: 1) } label: {
                Label("Move Down", systemImage: "arrow.down").font(OpenClawType.subhead)
            }.disabled(self.visibleSidebarEntries.last == .route(destination))
            Button { self.showsPagesEditor = true } label: {
                Label("Edit Pages…", systemImage: "square.and.pencil").font(OpenClawType.subhead)
            }
        }
        .accessibilityIdentifier("RootTabs.Sidebar.Destination.\(destination.rawValue)")
    }

    /// Attention lives on the rows that act on it (prototype parity): pending
    /// approvals surface on Overview, cron issues on Automations.
    private func badgeCount(for destination: RootTabs.SidebarDestination) -> Int {
        switch destination {
        case .overview: self.appModel.pendingExecApprovalCount
        case .cron: self.model.failedCronJobCount + self.model.overdueCronJobCount
        default: 0
        }
    }

    private var sessionViewMenu: some View {
        RootSidebarSessionViewMenu(
            options: self.$model.viewOptions,
            owners: self.model.owners ?? [],
            showsAllAgents: self.model.showsAllAgents,
            selectOwner: { self.showsOwnerFilter = true },
            selectSessions: { self.selectingSessions = true },
            createGroup: { self.groupDraft = ""
                self.showsNewGroup = true
            })
    }

    private func movePinnedPage(_ destination: RootTabs.SidebarDestination, by offset: Int) {
        self.moveSidebarEntry(.route(destination), by: offset)
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
                let identity = self.appModel.chatViewModelIdentityID
                let agentID = OpenClawChatSessionKey.agentID(from: session.key) ?? session.agentId
                let key = try await self.appModel.makeChatTransport().forkSession(
                    parentKey: session.key,
                    fromLastCompleted: session.hasActiveRun == true,
                    agentID: agentID)
                guard self.appModel.chatViewModelIdentityID == identity else { throw CancellationError() }
                if let agentID { self.appModel.setSelectedAgentId(agentID) }
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

    private func dismissSidebar() {
        self.isSearchFocused = false
        self.hideSidebar()
    }
}

// Web-parity Pages editor (the pen menu): navigate to any page, pin/unpin
// which ones stay in the sidebar. Home is fixed and not listed.

extension RootSidebar {
    private var identityMenu: some View {
        Group {
            Button { self.dashboardRoute = .init(
                path: DashboardRouteMap.appearanceSettingsPath,
                title: String(localized: "Settings")) } label: {
                Label("Settings…", systemImage: "gearshape").font(OpenClawType.subhead)
            }
            Button { self.selectSidebarDestination(.gateway) } label: {
                Label("Manage Gateways…", systemImage: "server.rack").font(OpenClawType.subhead)
            }
            Button { self.dashboardRoute = .init(path: "/settings/profile", title: String(localized: "Profile"))
            } label: {
                Label("Profile…", systemImage: "person.crop.circle").font(OpenClawType.subhead)
            }
            Picker(selection: Binding(
                get: { self.appearanceModel.preference },
                set: { self.appearanceModel.select($0) }))
            {
                Text("System").font(OpenClawType.subhead).tag(AppAppearancePreference.system)
                Text("Light").font(OpenClawType.subhead).tag(AppAppearancePreference.light)
                Text("Dark").font(OpenClawType.subhead).tag(AppAppearancePreference.dark)
            } label: { Label("Appearance", systemImage: "circle.lefthalf.filled").font(OpenClawType.subhead) }
            Button { self.selectSidebarDestination(.usage) } label: {
                Label("Usage", systemImage: "chart.bar").font(OpenClawType.subhead)
            }
            Button { self.dashboardRoute = .init(path: "/apps", title: String(localized: "Get Apps")) } label: {
                Label("Get Apps…", systemImage: "square.grid.2x2").font(OpenClawType.subhead)
            }
            Button { self.dashboardRoute = .init(path: "/settings/devices", title: String(localized: "Pair Device"))
            } label: {
                Label("Pair Device…", systemImage: "iphone").font(OpenClawType.subhead)
            }.disabled(!self.appModel.hasOperatorAdminScope)
            Button { self.dashboardRoute = .init(path: "/settings/about", title: String(localized: "About OpenClaw"))
            } label: {
                Label("About OpenClaw…", systemImage: "info.circle").font(OpenClawType.subhead)
            }
            Button { self.showsPagesEditor = true } label: {
                Label("Edit Sidebar…", systemImage: "sidebar.left").font(OpenClawType.subhead)
            }
            if self.appModel.lastGatewayProblem?.retryable == true {
                Button {
                    Task {
                        if case let .failed(message) = await self.gatewayController.retryGatewayConnection() {
                            self.model.reportSessionError(NSError(
                                domain: "Gateway",
                                code: 1,
                                userInfo: [NSLocalizedDescriptionKey: message]))
                        }
                    }
                } label: { Label("Retry Connection", systemImage: "arrow.clockwise").font(OpenClawType.subhead) }
            }
            Button { self.diagnosticsPath = [.diagnostics]
                self.showsDiagnostics = true
            } label: {
                Label("Diagnostics…", systemImage: "stethoscope").font(OpenClawType.subhead)
            }
            Menu {
                self.helpLink("Documentation", url: "https://docs.openclaw.ai")
                self.helpLink("Get Help", url: "https://docs.openclaw.ai/help")
                self.helpLink("Discord", url: "https://discord.gg/clawd")
                self.helpLink("Changelog", url: "https://docs.openclaw.ai/releases")
            } label: { Label("Help", systemImage: "questionmark.circle").font(OpenClawType.subhead) }
        }
    }

    private func helpLink(_ title: LocalizedStringKey, url: String) -> some View {
        Button { if let url = URL(string: url) { self.openURL(url) } } label: {
            Text(title).font(OpenClawType.subhead)
        }
    }

    private var batchRows: [OpenClawChatSessionEntry] {
        self.model.sessions.filter { self.selectedSessions.contains(OpenClawChatSessionSidebarData.identity($0)) }
    }

    private var batchMenu: some View {
        Group {
            Button {
                self
                    .selectedSessions = Set(self.visibleSessionSections.flatMap { Self.flattened($0.nodes) }
                        .map { OpenClawChatSessionSidebarData.identity($0.session) })
            } label: {
                Label("Select All", systemImage: "checkmark.circle").font(OpenClawType.subhead)
            }
            Button { self.selectedSessions = [] } label: {
                Label("Deselect All", systemImage: "circle").font(OpenClawType.subhead)
            }
            Divider()
            Button { self.performBatch("sessions.patch", fields: ["unread": OpenClawProtocol.AnyCodable(true)])
            } label: {
                Label("Mark as Unread", systemImage: "envelope.badge").font(OpenClawType.subhead)
            }.disabled(!self.batchAllows(.unread))
            Button { self.performBatch("sessions.patch", fields: ["unread": OpenClawProtocol.AnyCodable(false)])
            } label: {
                Label("Mark as Read", systemImage: "envelope.open").font(OpenClawType.subhead)
            }.disabled(!self.batchAllows(.unread))
            Menu {
                ForEach(self.sessionCategories, id: \.self) { name in
                    Button {
                        self.performBatch("sessions.patch", fields: ["category": OpenClawProtocol.AnyCodable(name)])
                    } label: {
                        Text(verbatim: name).font(OpenClawType.subhead)
                    }
                }
                Button {
                    self.performBatch("sessions.patch", fields: ["category": OpenClawProtocol.AnyCodable(NSNull())])
                } label: {
                    Text("Remove from Group").font(OpenClawType.subhead)
                }
            } label: { Label("Move to Group", systemImage: "folder").font(OpenClawType.subhead) }
                .disabled(!self.batchAllows(.group))
            Button { self.performBatch("sessions.patch", fields: ["archived": OpenClawProtocol.AnyCodable(true)])
            } label: {
                Label("Archive", systemImage: "archivebox").font(OpenClawType.subhead)
            }.disabled(!self.batchAllows(.archive) || self.batchRows.contains {
                !ChatSessionSidebarModel.canArchiveSession($0, mainSessionKey: self.resolvedMainSessionKey)
            })
            Button { self.performBatch("sessions.patch", fields: ["archived": OpenClawProtocol.AnyCodable(false)])
            } label: {
                Label("Restore", systemImage: "arrow.uturn.backward").font(OpenClawType.subhead)
            }.disabled(!self.batchAllows(.archive) || self.batchRows.contains { !$0.isArchived })
            Button(role: .destructive) {
                guard let connection = self.appModel.sessionGroups.connection, connection.isCurrent() else { return }
                self.pendingBatchDelete = BatchTarget(rows: self.batchRows, connection: connection)
                self.confirmsBatchDelete = true
            } label: {
                Label("Delete…", systemImage: "trash").font(OpenClawType.subhead)
            }.disabled(!self.batchAllows(.delete) || self.batchRows.contains {
                !ChatSessionSidebarModel.canDeleteSession(key: $0.key, mainSessionKey: self.resolvedMainSessionKey)
            })
        }
        .disabled(!self.appModel.isOperatorGatewayConnected)
    }

    private func prepareCapabilitiesDraft() {
        guard self.appModel.isOperatorGatewayConnected else { return }
        self.appModel.openChat(sessionKey: self.appModel.mainSessionKey)
        self.appModel.chatPresentation.sync(appModel: self.appModel)
        guard let viewModel = self.appModel.chatPresentation.viewModel else { return }
        // Preparing a suggestion must not erase an existing draft or send it.
        if viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            viewModel.input = String(localized: "What can you do?")
        } else {
            viewModel.input += "\n" + String(localized: "What can you do?")
        }
        self.selectSidebarDestination(.chat)
    }

    private func batchAllows(_ action: OpenClawSessionMenuAction) -> Bool {
        let rows = self.batchRows
        guard !rows.isEmpty, let connection = self.appModel.sessionGroups.connection else { return false }
        return rows.allSatisfy { connection.allows(action, session: $0) }
    }

    private func toggleSessionSelection(_ key: String) {
        if !self.selectedSessions.insert(key).inserted { self.selectedSessions.remove(key) }
    }

    private func menuConnection(for session: OpenClawChatSessionEntry) -> OpenClawSessionMenuConnection? {
        self.appModel.sessionGroups.connection?.bound(to: session) { row in
            self.model.sessions.contains { current in
                OpenClawChatSessionSidebarData.identity(current) == OpenClawChatSessionSidebarData.identity(row) &&
                    current.sessionId == row.sessionId
            }
        }
    }

    private func offerArchiveUndo(_ rows: [OpenClawChatSessionEntry], connection: OpenClawSessionMenuConnection?) {
        guard !rows.isEmpty else { return }
        self.archivedRows = rows
        self.archiveConnection = connection
        self.showsArchiveUndo = true
    }

    private func undoArchive() {
        let rows = self.archivedRows
        guard let connection = self.archiveConnection else { return }
        Task { @MainActor in
            do {
                for row in rows {
                    try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
                        "sessions.patch", session: row, fields: ["archived": .init(false)]))
                }
                self.archivedRows = []
                self.archiveConnection = nil
                await self.model.refreshSessions(appModel: self.appModel)
            } catch { self.model.reportSessionError(error) }
        }
    }

    private func performBatch(
        _ method: String,
        fields: [String: OpenClawProtocol.AnyCodable] = [:],
        target: BatchTarget? = nil)
    {
        // Confirmation keeps both the original incarnations and Gateway lease.
        let rows = target?.rows ?? self.batchRows
        guard !rows.isEmpty, let connection = target?.connection ?? self.appModel.sessionGroups.connection,
              connection.isCurrent() else { return }
        let action: OpenClawSessionMenuAction = method == "sessions.delete" ? .delete :
            fields["archived"] != nil ? .archive : fields["category"] != nil ? .group : .unread
        Task { @MainActor in
            var archived: [OpenClawChatSessionEntry] = []
            defer { self.offerArchiveUndo(archived, connection: connection) }
            do {
                for row in rows {
                    guard let current = self.menuConnection(for: row), current.allows(action, session: row) else {
                        throw OpenClawChatTransportSendError.notDispatched
                    }
                    // Mutation requests carry expectedSessionId; the captured gateway lease cannot switch routes.
                    try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
                        method,
                        session: row,
                        fields: fields))
                    if fields["archived"]?.value as? Bool == true { archived.append(row) }
                    self.selectedSessions.remove(OpenClawChatSessionSidebarData.identity(row))
                }
                self.selectingSessions = !self.selectedSessions.isEmpty
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                // Keep failed/unattempted rows selected; don't imply an atomic batch succeeded.
                self.model.reportSessionError(error)
            }
        }
    }

    private func createGroup() {
        let name = self.groupDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { @MainActor in
            await self.appModel.sessionGroups.mutate(
                appModel: self.appModel,
                request: OpenClawChatGatewayRequests.sessionGroupsPut(names: []),
                catalogNames: { SessionGroupStore.adding($0, name) },
                fallback: { _ in SessionGroupStore.remember(name) })
            if self.appModel.sessionGroups.failure == nil { self.showsNewGroup = false }
        }
    }
}

extension RootSidebar {
    /// Alias-aware main lookup: rosters may return namespaced keys
    /// ("agent:<id>:main"), so raw comparison would drop Home's badges.
    private var mainSessionEntry: OpenClawChatSessionEntry? {
        let mainKey = self.resolvedMainSessionKey
        return self.model.sessions.first { $0.key == mainKey }
    }

    private var resolvedMainSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.model.sessions,
            currentSessionKey: "main",
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var resolvedSelectedSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.model.sessions,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var visibleSessionSections: [ChatSessionSidebarModel.Section] {
        if self.model.showsAllAgents {
            return self.selectableAgents.compactMap { agent in
                let agentRows = self.model.sessions.filter {
                    ChatSessionSidebarModel.isSessionInActiveAgentScope(
                        key: $0.key,
                        agentID: $0.agentId,
                        activeAgentID: agent.id)
                }
                var options = self.model.viewOptions
                options.selectedAgentID = agent.id
                options.grouping = .none
                let sections = RootSidebarModel.sections(
                    sessions: agentRows,
                    query: self.searchText,
                    currentSessionKey: "",
                    mainSessionKey: self.appModel.mainSessionKey,
                    activeAgentID: agent.id,
                    groups: [],
                    viewOptions: options,
                    owners: self.model.owners,
                    selfOwnerID: self.model.involvingProfileID)
                let nodes = sections.flatMap(\.nodes)
                guard !nodes.isEmpty else { return nil }
                return .init(id: "agent:" + agent.id, title: Self.agentDisplayName(agent), nodes: nodes)
            }
        }
        return self.model.sections(
            query: self.searchText,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            groups: self.sessionGroups,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    struct SessionLayout: Equatable {
        let pinnedNodes: [ChatSessionSidebarModel.Node]
        let sections: [ChatSessionSidebarModel.Section]

        @MainActor func reconciledEntries(_ entries: [RootTabs.SidebarEntry]) -> [RootTabs.SidebarEntry] {
            RootTabs.reconciledSidebarEntries(
                entries,
                pinnedSessionKeys: self.pinnedNodes.map { RootTabs.sidebarSessionSlot(for: $0.session) })
        }
    }

    static func sessionLayout(_ sections: [ChatSessionSidebarModel.Section]) -> SessionLayout {
        guard let pinnedIndex = sections.firstIndex(where: { $0.id == "pinned" }) else {
            return SessionLayout(pinnedNodes: [], sections: sections)
        }
        var remainingSections = sections
        let pinnedSection = remainingSections.remove(at: pinnedIndex)
        return SessionLayout(pinnedNodes: pinnedSection.nodes, sections: remainingSections)
    }

    private var sessionCategories: [String] {
        self.appModel.sessionGroups.names(for: self.model.sessions)
    }

    private var sessionGroups: [OpenClawChatSessionGroup] {
        self.sessionCategories.enumerated().map { offset, name in
            OpenClawChatSessionGroup(name: name, position: offset)
        }
    }

    private static func flattened(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Node] {
        nodes.flatMap { [$0] + self.flattened($0.children) }
    }

    private func sessionRows(for section: ChatSessionSidebarModel.Section) -> [ChatSessionSidebarModel.Row] {
        let nodes = section.nodes
        guard section.id == "recent", let limit = Self.recentSessionCap(searchText: self.searchText) else {
            return self.rows(nodes)
        }
        return self.rows(Array(nodes.prefix(limit)))
    }

    private func rows(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Row] {
        ChatSessionSidebarModel.rows(nodes, showsChildren: self.showsChildren)
    }

    /// Keep search results and the selected descendant visible even when their parent was not opened.
    private func showsChildren(of node: ChatSessionSidebarModel.Node) -> Bool {
        self.expandedSessions.contains(node.id) || self.mustShowChildren(of: node)
    }

    private func mustShowChildren(of node: ChatSessionSidebarModel.Node) -> Bool {
        !self.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || Self.flattened(node.children).contains { $0.session.key == self.resolvedSelectedSessionKey }
    }

    static func recentSessionCap(searchText: String) -> Int? {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 20 : nil
    }

    private func sessionButton(
        _ node: ChatSessionSidebarModel.Node,
        selectedSessionKey: String,
        depth: Int = 0) -> some View
    {
        let session = node.session
        let isSelected = session.key == selectedSessionKey
        return HStack(spacing: 0) {
            Button {
                if self.selectingSessions {
                    self.toggleSessionSelection(OpenClawChatSessionSidebarData.identity(session))
                } else {
                    self.selectSession(session)
                }
            } label: {
                HStack(spacing: 9) {
                    if self.selectingSessions {
                        Image(systemName: self.selectedSessions
                            .contains(OpenClawChatSessionSidebarData.identity(session))
                            ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(OpenClawSidebarPalette.accent)
                    }
                    ZStack {
                        if node.badges.runningCount > 0 {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(OpenClawSidebarPalette.accent)
                        } else {
                            RootSidebarSessionIcon(icon: session.icon)
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
                        // Web-parity subtitle: the work line (repo/branch) names the
                        // session; recency moves to the trailing metadata slot.
                        if let subtitle = ChatSessionSidebarModel.subtitle(
                            for: session,
                            workSubtitle: ChatSessionSidebarModel.workSubtitle(for: session))
                        {
                            Text(verbatim: subtitle)
                                .font(OpenClawType.caption2Medium)
                                .foregroundStyle(OpenClawSidebarPalette.muted)
                                .lineLimit(1)
                        }
                        if self.model.viewOptions.showMessagePreview,
                           let preview = session.lastMessagePreview, !preview.isEmpty
                        {
                            Text(verbatim: preview).font(OpenClawType.caption)
                                .foregroundStyle(OpenClawSidebarPalette.muted).lineLimit(2)
                        }
                    }

                    Spacer(minLength: 4)
                    if session.pinned == true {
                        Image(systemName: "pin.fill")
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawSidebarPalette.accent)
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: CommandCenterTab.sessionDetail(session))
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                    if session.unread == true {
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
            .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
                cornerRadius: OpenClawProMetric.controlRadius,
                style: .continuous))
            .overlay(alignment: .leading) {
                OpenClawSessionColorStripe(color: session.color)
            }
            .commandSessionActions(
                session: session,
                mainSessionKey: self.resolvedMainSessionKey,
                categories: self.sessionCategories,
                isEnabled: self.appModel.isOperatorGatewayConnected,
                canArchive: ChatSessionSidebarModel.canArchiveSession(
                    session,
                    mainSessionKey: self.resolvedMainSessionKey),
                canDelete: ChatSessionSidebarModel.canDeleteSession(
                    key: session.key,
                    mainSessionKey: self.resolvedMainSessionKey),
                performMutation: self.performSessionMutation,
                fork: { self.forkSession(session) },
                select: {
                    self.selectingSessions = true
                    self.selectedSessions.insert(OpenClawChatSessionSidebarData.identity(session))
                },
                onArchived: { row, _ in
                    self.offerArchiveUndo([row], connection: self.appModel.sessionGroups.connection)
                },
                moveUp: self.sessionMoveAction(session, offset: -1),
                moveDown: self.sessionMoveAction(session, offset: 1))
            .environment(\.commandSessionMenuConnection, self.menuConnection(for: session))
            .accessibilityValue(Self.sessionAccessibilityValue(
                isPinned: session.pinned == true,
                isUnread: session.unread == true))
            .accessibilityIdentifier("RootTabs.Sidebar.Session.\(session.key)")
            if !node.children.isEmpty {
                let isExpanded = self.showsChildren(of: node)
                Button {
                    if self.expandedSessions.contains(node.id) {
                        self.expandedSessions.remove(node.id)
                    } else {
                        self.expandedSessions.insert(node.id)
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        // The open parent shows its rows; the number is kept in the layout so the caret stays put.
                        Text(verbatim: "\(node.children.count)")
                            .opacity(isExpanded ? 0 : 1)
                            .accessibilityHidden(isExpanded)
                    }
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isExpanded
                    ? String(localized: "Hide Sub-sessions")
                    : String(localized: "Show Sub-sessions"))
                .accessibilityValue(Text(verbatim: isExpanded ? "" : String(node.children.count)))
                .accessibilityIdentifier("RootTabs.Sidebar.Session.Children.\(session.key)")
                .disabled(self.mustShowChildren(of: node))
            }
            self.attentionBadges(for: Self.flattened([node]).map(\.session), targetID: "session:\(session.key)")
        }
        .padding(.leading, CGFloat(min(depth, 6)) * 16)
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
            requests: questions + self.appModel.pendingApprovalAttentionRequests,
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

    static func sessionAccessibilityValue(isPinned: Bool, isUnread: Bool) -> String {
        var states: [String] = []
        if isPinned {
            states.append(String(localized: "Pinned"))
        }
        if isUnread {
            states.append(String(localized: "Unread"))
        }
        return states.joined(separator: ", ")
    }
}

extension RootSidebar {
    /// The current agent is the single roster entry. Opening it shows every
    /// selectable agent and native Picker selection state.
    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let selectedAgent = self.selectedAgent {
                HStack(spacing: 0) {
                    Menu {
                        Picker(selection: Binding(
                            get: { selectedAgent.id },
                            set: { self.appModel.setSelectedAgentId($0) }))
                        {
                            ForEach(self.selectableAgents, id: \.id) { agent in
                                Label {
                                    Text(verbatim: Self.agentDisplayName(agent))
                                        .font(OpenClawType.subheadSemiBold)
                                } icon: {
                                    self.agentMenuAvatarImage(agent)
                                        .renderingMode(.original)
                                }
                                .tag(agent.id)
                            }
                        } label: {
                            Text(String(localized: "Agent"))
                        }
                        .pickerStyle(.inline)
                    } label: {
                        self.agentSelectorLabel(selectedAgent)
                    }
                    .menuIndicator(.hidden)
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button { self.showsAgentPicker = true } label: {
                            Label("Switch Agent…", systemImage: "person.2").font(OpenClawType.subhead)
                        }
                        Button { self.model.showsAllAgents.toggle() } label: {
                            Label(
                                self.model.showsAllAgents ? "Selected Agent Only" : "All Agents",
                                systemImage: "person.3").font(OpenClawType.subhead)
                        }
                        Button { self.selectSidebarDestination(.agents) } label: {
                            Label("All Agents…", systemImage: "person.2").font(OpenClawType.subhead)
                        }
                        Button { self.dashboardRoute = .init(
                            path: "/custodian",
                            title: String(localized: "New Agent"),
                            queryItems: [.init(name: "intent", value: "new-agent")])
                        } label: {
                            Label("New Agent…", systemImage: "person.badge.plus").font(OpenClawType.subhead)
                        }
                        Button { self.dashboardRoute = .init(
                            path: "/settings/agents/" +
                                (AuthenticatedControlUI.percentEncodedPathSegment(selectedAgent.id) ?? ""),
                            title: String(localized: "Agent Settings")) } label: {
                            Label("Agent Settings…", systemImage: "slider.horizontal.3").font(OpenClawType.subhead)
                        }
                        Button { self.prepareCapabilitiesDraft() } label: {
                            Label("What Can This Agent Do?", systemImage: "square.stack.3d.up")
                                .font(OpenClawType.subhead)
                        }
                    }
                    .accessibilityIdentifier("RootTabs.Sidebar.AgentSelector")
                    .accessibilityLabel(String(localized: "Agent"))
                    .accessibilityValue(Self.agentDisplayName(selectedAgent))
                    self.attentionBadges(for: self.model.sessions, targetID: "agent:\(selectedAgent.id)")
                }
            }

            self.newChatButton
        }
    }

    private var selectableAgents: [AgentSummary] {
        self.appModel.gatewayAgents.filter(\.isSelectableAgent)
    }

    private var selectedAgent: AgentSummary? {
        self.selectableAgents.first(where: { $0.id == self.currentAgentID })
    }

    private func agentSelectorLabel(_ agent: AgentSummary) -> some View {
        HStack(spacing: 9) {
            ZStack(alignment: .bottomTrailing) {
                self.agentAvatarBadge(agent, size: 28)
                Circle()
                    .fill(OpenClawBrand.ok)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(OpenClawSidebarPalette.background, lineWidth: 1.5))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: Self.agentDisplayName(agent))
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)
                if let model = Self.agentModelLabel(agent) {
                    Text(verbatim: model)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.up.chevron.down")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
    }

    private var newChatButton: some View {
        Button {
            self.appModel.requestNewChat()
            self.selectSidebarDestination(.chat)
        } label: {
            Label {
                Text(String(localized: "New Chat"))
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                Image(systemName: "plus.bubble")
                    .font(OpenClawType.subheadSemiBold)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.accent)
        .disabled(!self.appModel.isOperatorGatewayConnected)
        .accessibilityLabel(String(localized: "New Chat"))
    }

    /// Same key order the Agents roster uses for its model subtitles.
    static func agentModelLabel(_ agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["primary", "name", "id", "model"] {
            if let value = (model[key]?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty
            {
                return value
            }
        }
        return nil
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

    static func agentDisplayName(_ agent: AgentSummary) -> String {
        let name = agent.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? agent.id : name
    }

    static func agentBadge(name: String, identity: [String: OpenClawProtocol.AnyCodable]?) -> String {
        AgentIdentityPresentation.badge(
            avatarText: identity?["emoji"]?.value as? String,
            displayName: name)
    }

    private func agentAvatarBadge(_ agent: AgentSummary, size: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(OpenClawSidebarPalette.elevated)
            Text(verbatim: Self.agentBadge(name: Self.agentDisplayName(agent), identity: agent.identity))
                .font(OpenClawType.caption2Bold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .minimumScaleFactor(0.65)
                .lineLimit(1)
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(OpenClawSidebarPalette.hairline, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private func agentMenuAvatarImage(_ agent: AgentSummary) -> Image {
        let renderer = ImageRenderer(content: self.agentAvatarBadge(agent, size: 24)
            .environment(\.colorScheme, self.colorScheme))
        renderer.scale = self.displayScale
        guard let image = renderer.uiImage else {
            return Image(systemName: "person.crop.circle")
        }
        return Image(uiImage: image)
    }
}
