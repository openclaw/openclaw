import Foundation
import Testing

struct RootTabsSourceGuardTests {
    @Test func `hidden sidebar reveal uses destination header without reserved rail`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let componentSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)

        #expect(source.contains("sidebarHeaderLeadingAction"))
        #expect(source.contains("Hide Sidebar"))
        #expect(source.contains("Show Sidebar"))
        #expect(source.contains("shouldShowSidebarRevealInDestinationHeader"))
        #expect(source.contains("layoutMode: self.isSidebarDrawerLayout ? .drawer : .split"))
        #expect(componentSource.contains("OpenClawSidebarHeaderLeadingSlot"))
        #expect(componentSource.contains(".frame(width: 44, height: 44, alignment: .center)"))
        #expect(source.contains(".safeAreaPadding(.top, 8)"))
        #expect(source.contains("Self.sidebarShowButtonAccessibilityIdentifier"))
        #expect(source.contains("Self.sidebarHideButtonAccessibilityIdentifier"))
        #expect(source.contains("accessibilityLabel: \"Hide Sidebar\""))
        #expect(source.contains("accessibilityLabel: \"Show Sidebar\""))
        #expect(source.contains("action: { self.hideSidebar() }"))
        #expect(source.contains("action: { self.showSidebar() }"))
        #expect(!source.contains("private var collapsedSidebarRail: some View"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(source.contains("requestedInitialSidebarVisibility"))
        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!source.contains("NavigationSplitView(columnVisibility: self.$splitColumnVisibility)"))
        #expect(source.contains("HStack(spacing: 0)"))
        #expect(!source.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(!source.contains("shouldReserveSidebarRevealInset"))
        #expect(!source.contains("safeAreaInset(edge: .top"))
        #expect(!source.contains("thinMaterial, in: Circle"))
        #expect(!source.contains("sidebarRevealInset"))
        #expect(source.contains("Color.black.opacity(0.28)"))
        #expect(source.contains(".background(Color(uiColor: .systemBackground))"))
        #expect(!source.contains("sidebarRevealCornerButton"))
        #expect(!source.contains("shouldShowSidebarRevealOverlay"))
        #expect(!source.contains("shouldShowOverviewHeaderSidebarReveal"))
    }

    @Test func `i pad split uses sliding sidebar while portrait keeps drawer overlay`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let splitContent = try Self.extract(
            source,
            from: "private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View",
            to: "private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View")
        let drawerContent = try Self.extract(
            source,
            from: "private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View",
            to: "private var sidebarDetailShell: some View")

        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!source.contains("Self.sidebarSplitColumnVisibility(isSidebarVisible:"))
        #expect(!source.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(splitContent.contains("HStack(spacing: 0)"))
        #expect(splitContent.contains("self.sidebarColumn"))
        #expect(splitContent.contains(".frame(width: sidebarWidth, alignment: .topLeading)"))
        #expect(splitContent.contains(".overlay(alignment: .trailing)"))
        #expect(splitContent.contains("self.sidebarVerticalSeparator"))
        #expect(splitContent.contains("self.sidebarDetailNavigationShell"))
        #expect(!splitContent.contains("NavigationSplitView"))
        #expect(!splitContent.contains("self.collapsedSidebarRail"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(drawerContent.contains("ZStack(alignment: .topLeading)"))
        #expect(drawerContent.contains("Color.black.opacity(0.28)"))
        #expect(drawerContent.contains(".transition(.move(edge: .leading).combined(with: .opacity))"))
        #expect(!drawerContent.contains("NavigationSplitView"))
    }

    @Test func `phone tab bar keeps chat first product order`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let phoneTabContent = try Self.extract(
            source,
            from: "private var phoneTabContent: some View",
            to: "private var sidebarSplitContent: some View")

        let chatRange = try #require(phoneTabContent.range(of: "ChatProTab(openSettings:"))
        let talkRange = try #require(phoneTabContent.range(of: "TalkProTab(openSettings:"))
        let controlRange = try #require(phoneTabContent.range(of: "RootTabsPhoneControlHub("))
        let agentRange = try #require(phoneTabContent.range(of: "AgentProTab("))
        let settingsRange = try #require(phoneTabContent.range(of: "SettingsProTab("))

        #expect(chatRange.lowerBound < talkRange.lowerBound)
        #expect(talkRange.lowerBound < controlRange.lowerBound)
        #expect(controlRange.lowerBound < agentRange.lowerBound)
        #expect(agentRange.lowerBound < settingsRange.lowerBound)
    }

    @Test func `sidebar keeps navigation model destination only`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let navigationSource = try String(contentsOf: Self.rootTabsNavigationSourceURL(), encoding: .utf8)
        let sidebarColumn = try Self.extract(
            source,
            from: "private var sidebarColumn: some View",
            to: "private var sidebarList: some View")

        #expect(source.contains("ForEach(Self.sidebarGroups)"))
        #expect(!source.contains("Section(\"Context\")"))
        #expect(!source.contains("sidebarAgentMenu"))
        #expect(!source.contains("sidebarDeviceMenu"))
        #expect(sidebarColumn.contains("self.sidebarIdentityHeader"))
        #expect(source.contains("private var sidebarIdentityHeader: some View"))
        #expect(source.contains("OpenClawProMark(size: 30"))
        #expect(source.contains("Text(\"OpenClaw\")"))
        #expect(source.contains("private var sidebarGatewayStatusTitle: String"))
        #expect(source.contains("private var sidebarGatewayStatusColor: Color"))
        #expect(!sidebarColumn.contains("activeAgent"))
        #expect(!source.contains("shouldShowSidebarColumnHeader"))
        #expect(!source.contains("private var sidebarColumnHeader: some View"))
        #expect(sidebarColumn.contains(".safeAreaPadding(.top, 8)"))
        #expect(source.contains(".scrollContentBackground(.hidden)"))
        #expect(source.contains(".listStyle(.sidebar)"))
        #expect(source.contains("private var sidebarHorizontalSeparator: some View"))
        #expect(source.contains("private var sidebarVerticalSeparator: some View"))
        #expect(source.contains("1 / UIScreen.main.scale"))
        #expect(!source.contains("geometry.size.height >= Self.sidebarListNonScrollingMinimumHeight"))
        #expect(!source.contains("private var sidebarListContent: some View"))
        #expect(source.contains(".listRowSeparator(.hidden, edges: .all)"))
        #expect(source.contains(".listSectionSeparator(.hidden, edges: .all)"))
        #expect(source.contains("if self.isSidebarDrawerLayout {"))
        #expect(source.contains("private var sidebarFooter: some View"))
        #expect(!source.contains("LabeledContent(\"Version\""))
        #expect(navigationSource.contains("SidebarGroup(title: \"CHAT\", destinations: [.chat, .talk])"))
        #expect(!navigationSource.contains("title: \"AGENT\""))
        #expect(navigationSource.contains("case settings"))
        #expect(!navigationSource.contains("case settingsChannels"))
        #expect(!navigationSource.contains("case settingsApprovals"))
        #expect(!navigationSource.contains("case settingsPrivacy"))
        #expect(navigationSource.contains("SidebarGroup(\n            title: \"SETTINGS\""))
        #expect(navigationSource.contains("destinations: [.settings]"))
        #expect(!navigationSource.contains("destinations: [.gateway"))
        #expect(!navigationSource.contains("SidebarGroup(title: \"REFERENCE\", destinations: [.settings"))
        #expect(navigationSource.contains("SidebarGroup(title: \"REFERENCE\", destinations: [.docs])"))
    }

    @Test func `sidebar routes use destination headers instead of repeated product branding`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let sidebarDetail = try Self.extract(
            rootSource,
            from: "private var sidebarDetail: some View",
            to: "private var sidebarDetailNavigationShell: some View")

        #expect(sidebarDetail.contains("headerTitle: \"Chat\""))
        #expect(sidebarDetail.contains("headerTitle: \"Overview\""))
        #expect(sidebarDetail.contains("headerTitle: \"Agents\""))
        #expect(sidebarDetail.contains("headerTitle: \"Instances\""))
        #expect(!sidebarDetail.contains("headerTitle: \"Nodes\""))
        #expect(sidebarDetail.contains("directRoute: .agents"))
        #expect(sidebarDetail.contains("directRoute: .instances"))
        #expect(sidebarDetail.contains("directRoute: .dreaming"))
        #expect(sidebarDetail.contains("directRoute: .usage"))
        #expect(sidebarDetail.contains("directRoute: .cron"))
        #expect(!sidebarDetail.contains("initialRoute: .nodes"))
        #expect(!sidebarDetail.contains("initialRoute: .usage"))
        #expect(!sidebarDetail.contains("initialRoute: .cron"))
        #expect(sidebarDetail.contains("headerTitle: \"Dreaming\""))
        #expect(sidebarDetail.contains("headerTitle: \"Usage\""))
        #expect(sidebarDetail.contains("headerTitle: \"Cron Jobs\""))
        #expect(!sidebarDetail.contains("headerTitle: \"OpenClaw\""))
        #expect(agentOverviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(agentOverviewSource.contains("title: self.headerTitle"))
        #expect(!agentOverviewSource.contains("Text(\"OpenClaw\")"))
        #expect(docsSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(docsSource.contains("title: \"Docs\""))
        #expect(!docsSource.contains("Text(\"OpenClaw Docs\")"))
    }

    @Test func `agents direct route keeps single sidebar control`() throws {
        let source = try String(contentsOf: Self.agentProTabSourceURL(), encoding: .utf8)
        let destinationsSource = try String(contentsOf: Self.agentProTabDestinationsSourceURL(), encoding: .utf8)
        let nodesSource = try String(contentsOf: Self.agentProNodesDestinationSourceURL(), encoding: .utf8)
        let dreamingSource = try String(contentsOf: Self.agentProDreamingDestinationSourceURL(), encoding: .utf8)

        #expect(!source.contains("ToolbarItem"))
        #expect(source.contains("self.directHeaderLeadingAction(for: route) == nil ? .visible : .hidden"))
        #expect(destinationsSource.contains("self.directHeaderLeadingAction(for: .instances)"))
        #expect(destinationsSource.contains("self.directHeaderLeadingAction(for: .dreaming)"))
        #expect(destinationsSource.contains("self.directHeader(\n                        for: .usage"))
        #expect(destinationsSource.contains("self.directHeader(\n                        for: .cron"))
        #expect(destinationsSource.contains("self.directRoute == route ? self.headerLeadingAction : nil"))
        #expect(nodesSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
        #expect(dreamingSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
    }

    @Test func `routed headers use shared adaptive layout`() throws {
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let featureChromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let overviewSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)

        #expect(componentsSource.contains("struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View"))
        #expect(componentsSource.contains("ViewThatFits(in: .horizontal)"))
        #expect(componentsSource.contains("private var stackedLayout: some View"))
        #expect(componentsSource.contains(".layoutPriority(1)"))
        #expect(componentsSource.contains(".fixedSize(horizontal: true, vertical: false)"))
        #expect(featureChromeSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(docsSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(overviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(chatSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(agentOverviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(settingsSource.contains("OpenClawAdaptiveHeaderRow("))
    }

    @Test func `phone hub keeps docs as destination only`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("case .docs:"))
        #expect(source.contains("OpenClawDocsScreen("))
        #expect(source.contains("headerLeadingAction: self.phoneDetailBackAction"))
        #expect(source.contains("gatewayAction: { self.openPhoneRootDestination(.gateway) }"))
        #expect(!source.contains("Label(\"Docs\", systemImage: \"book\")"))
        #expect(!source.contains("https://docs.openclaw.ai"))
    }

    @Test func `root shell preview matrix covers phone and I pad states`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\n    \"Shell iPhone portrait\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone landscape\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone connected\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone gateway error\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad portrait drawer\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad landscape split\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad connecting\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad gateway error\""))
    }

    @Test func `shared chat preview matrix covers connection states`() throws {
        let source = try String(contentsOf: Self.sharedChatPreviewSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Chat connected\")"))
        #expect(source.contains("#Preview(\"Chat empty\")"))
        #expect(source.contains("#Preview(\"Chat loading\")"))
        #expect(source.contains("#Preview(\"Chat gateway error\")"))
        #expect(source.contains("enum Scenario"))
        #expect(source.contains("case connected"))
        #expect(source.contains("case empty"))
        #expect(source.contains("case loading"))
        #expect(source.contains("case error"))
        #expect(source.contains("Gateway not connected. Check Tailscale and retry."))
    }

    @Test func `phone hub keeps content above floating tab bar`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains(".safeAreaPadding(.bottom, self.bottomScrollInset)"))
        #expect(!source.contains(".padding(.bottom, self.bottomScrollInset)"))
        #expect(!source.contains("bottomViewportInset"))
        #expect(!source.contains("bottomTabBarClearance"))
    }

    @Test func `phone hub header stays task first`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("private var gatewayActionRow: some View"))
        #expect(source.contains("self.openPhoneRootDestination(.gateway)"))
        #expect(source.contains("private var phoneDetailBackAction: OpenClawSidebarHeaderAction"))
        #expect(source.contains("accessibilityLabel: \"Back to Control\""))
        #expect(source.contains("accessibilityIdentifier: \"OpenClawPhoneDetailBackButton\""))
        #expect(source.contains(".navigationBarBackButtonHidden(true)"))
        #expect(source.contains(".toolbar(.hidden, for: .navigationBar)"))
        #expect(source.matches(of: /headerLeadingAction: self\.phoneDetailBackAction/).count == 10)
        #expect(!source.contains("directRoute: .agents"))
        #expect(!source.contains("ToolbarItem(placement: .topBarTrailing)"))
        #expect(!source.contains("Image(systemName: \"gearshape\")"))
        #expect(!source.contains("self.metric(label:"))
        #expect(!source.contains("private func metric(label:"))
    }

    @Test func phoneHubClearsDetailPathBeforeRootTabHandoff() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)
        let handoff = try Self.extract(
            source,
            from: "private func openPhoneRootDestination(_ destination: RootTabs.SidebarDestination)",
            to: "private func opensRootTab(_ destination: RootTabs.SidebarDestination)")
        let clearRange = try #require(handoff.range(of: "self.navigationPath.removeAll()"))
        let openRange = try #require(handoff.range(of: "self.openRootDestination(destination)"))

        #expect(source.contains("NavigationStack(path: self.$navigationPath)"))
        #expect(!source.contains("self.openRootDestination(.gateway)"))
        #expect(source.contains("self.openPhoneRootDestination(.gateway)"))
        #expect(clearRange.lowerBound < openRange.lowerBound)
    }

    @Test func workboardUsesRealGatewayMethods() throws {
        let source = try String(contentsOf: Self.iPadWorkboardScreenSourceURL(), encoding: .utf8)

        #expect(source.contains("workboard.cards.list"))
        #expect(source.contains("workboard.cards.create"))
        #expect(source.contains("workboard.cards.move"))
        #expect(source.contains("workboard.cards.archive"))
        #expect(source.contains("workboard.cards.dispatch"))
        #expect(source.contains(".padding(.bottom, 12)"))
        #expect(!source.contains("Workboard gateway contract unavailable"))
        #expect(!source.contains("supportsGatewayContract"))
        #expect(!source.contains("Compact mobile queue control"))
        #expect(!source.contains("Multi-column queue control"))
    }

    @Test func `workboard create action surfaces unavailable reasons`() throws {
        let source = try String(contentsOf: Self.iPadWorkboardScreenSourceURL(), encoding: .utf8)
        let createFunction = try Self.extract(
            source,
            from: "private func createCard() async -> Bool",
            to: "private func move(_ card: IPadWorkboardCard, to status: String) async")

        #expect(source.contains("private var createUnavailableMessage: String?"))
        #expect(source.contains("Enter a title to create a card."))
        #expect(source.contains("Card creation is already in progress."))
        #expect(source.contains("private func newCardButton(expands: Bool) -> some View"))
        #expect(source.contains("private func beginCreateCard()"))
        #expect(source.contains("self.newCardButton(expands: false)"))
        #expect(source.contains("self.newCardButton(expands: true)"))
        #expect(source.contains("Label(\"New Card\", systemImage: \"plus\")"))
        #expect(source.contains(".accessibilityHint(\"Opens card title and notes entry\")"))
        #expect(source.contains(".accessibilityHint(self.createUnavailableMessage ?? \"Creates a workboard card\")"))
        #expect(source.contains("if await self.createCard()"))
        #expect(source.contains(".disabled(self.isCreatingCard)"))
        #expect(!source.contains("Button(\"Create\")"))
        #expect(!source.contains("TextField(\"New card\""))
        #expect(!source.contains(".disabled(!self.canWrite || self.draftTitle"))
        #expect(createFunction.contains("self.errorText = createUnavailableMessage"))
        #expect(createFunction.contains("return false"))
        #expect(createFunction.contains("return true"))
    }

    @Test func `task scope controls send real gateway params`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()

        #expect(source.contains("private var boardScopeMenu: some View"))
        #expect(source.contains("method: \"workboard.boards.list\""))
        #expect(source.contains("IPadWorkboardListParams(boardId: selectedBoardParam)"))
        #expect(source.contains("boardId: selectedBoardParam"))
        #expect(source
            .matches(
                of: /method: "workboard\.cards\.dispatch"[\s\S]*?IPadWorkboardListParams\(boardId: selectedBoardParam\)/)
            .count == 1)
        #expect(source.contains("private var agentScopeMenu: some View"))
        #expect(source.contains("IPadSkillProposalListParams(agentId: selectedAgentParam)"))
        #expect(source.contains("agentId: selectedAgentParam"))
        #expect(!source
            .contains(
                "params: EmptyParams(),\n                timeoutSeconds: 20)\n            let response = try JSONDecoder().decode(IPadSkillProposalManifest.self"))
    }

    @Test func `compact task rows keep phone native actions`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()
        let compactControls = try Self.extract(
            source,
            from: "private var compactQueueControls: some View",
            to: "private var compactRefreshButton: some View")

        #expect(source.contains("struct IPadWorkboardQueueRow"))
        #expect(source.contains("private var actionMenuItems: some View"))
        #expect(source.components(separatedBy: ".contextMenu {").count - 1 >= 2)
        #expect(source.components(separatedBy: ".swipeActions(edge: .leading").count - 1 >= 2)
        #expect(source.components(separatedBy: ".swipeActions(edge: .trailing").count - 1 >= 2)
        #expect(source.contains("@State private var presentedProposalRoute: IPadSkillProposalSheetRoute?"))
        #expect(source.contains(".sheet(item: self.$presentedProposalRoute)"))
        #expect(source.contains("private func selectProposal("))
        #expect(!source.contains("proposalSheetPresented"))
        #expect(source.contains("self.presentedSheet = .card(card)"))
        #expect(!source.contains("Label(\"Gateway\", systemImage: \"network\")"))
        #expect(!source.contains("Button(\"Gateway\")"))
        #expect(!source.contains("actionTitle: self.canRead ? nil : \"Gateway\""))
        #expect(!source.contains("Workboard offline"))
        #expect(!source.contains("Workshop offline"))
        #expect(!source.contains("Connect gateway to"))
        #expect(source.contains("private var compactRefreshButton: some View"))
        #expect(source.contains("private var compactBoardScopeMenu: some View"))
        #expect(source.contains("Color(uiColor: .secondarySystemGroupedBackground)"))
        #expect(source.contains(".allowsHitTesting(false)"))
        #expect(compactControls.contains("self.compactRefreshButton"))
        #expect(compactControls.contains("self.compactBoardScopeMenu"))
        #expect(!compactControls.contains("Self.workboardSubtitle("))
        #expect(!compactControls.contains("Label(\"Refresh\""))
        #expect(compactControls.contains("Label(\"Dispatch\""))
    }

    @Test func `skill workshop uses kanban lanes on wide I pad`() throws {
        let source = try String(contentsOf: Self.iPadSkillWorkshopScreenSourceURL(), encoding: .utf8)
        let previewSource = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)
        let content = try Self.extract(
            source,
            from: "private var proposalContent: some View",
            to: "private var proposalBoard: some View")
        let board = try Self.extract(
            source,
            from: "private var proposalBoard: some View",
            to: "private var proposalList: some View")

        #expect(content.contains("if self.isCompactWidth"))
        #expect(content.contains("self.proposalList"))
        #expect(content.contains("self.proposalBoard"))
        #expect(!content.contains("self.proposalDetail"))
        #expect(board.contains("ScrollView(.horizontal)"))
        #expect(board.contains("IPadSkillProposalKanbanColumn("))
        #expect(source.contains("private struct IPadSkillProposalKanbanCard"))
        #expect(source.contains("static let defaultProposalStatusBoardLanes"))
        #expect(source.contains("private func proposals(forLaneStatus status: String)"))
        #expect(previewSource.contains("#Preview(\n    \"Skill Workshop iPad kanban lanes\""))
        #expect(previewSource.contains("private struct IPadSkillWorkshopKanbanPreview"))
        #expect(previewSource.contains("IPadSkillProposalKanbanColumn("))
        #expect(previewSource.contains("status: \"needs-review\""))
        #expect(previewSource.contains("status: \"manual_QA\""))
    }

    @Test func `compact task rows have populated phone previews`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Workboard phone queue rows\")"))
        #expect(source.contains("#Preview(\"Skill Workshop phone queue rows\")"))
        #expect(source.contains("private struct IPadWorkboardCompactRowsPreview"))
        #expect(source.contains("private struct IPadSkillWorkshopCompactRowsPreview"))
        #expect(source.contains("IPadWorkboardPreviewFixtures.cards"))
        #expect(source.contains("IPadSkillWorkshopPreviewFixtures.proposals"))
    }

    @Test func `task screen preview matrices cover primary states`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Workboard states\")"))
        #expect(source.contains("private struct IPadWorkboardStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Connected\")"))
        #expect(source.contains("self.previewHeader(\"Empty\")"))
        #expect(source.contains("self.previewHeader(\"Loading\")"))
        #expect(source.contains("self.previewHeader(\"Error\")"))
        #expect(source.contains("title: \"Loading cards\""))
        #expect(source.contains("title: \"Cards unavailable\""))
        #expect(source.contains("IPadWorkboardKanbanColumn("))

        #expect(source.contains("#Preview(\"Skill Workshop states\")"))
        #expect(source.contains("private struct IPadSkillWorkshopStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Offline / Error\")"))
        #expect(source.contains("title: \"No proposals\""))
        #expect(source.contains("title: \"Workshop offline\""))
        #expect(source.contains("title: \"Proposal unavailable\""))
        #expect(source.contains("#Preview(\n    \"Skill Workshop iPad kanban lanes\""))
        #expect(source.contains("private struct IPadSkillWorkshopKanbanPreview"))
        #expect(source.contains("\"needs-review\""))
        #expect(source.contains("\"manual_QA\""))
    }

    @Test func `activity preview matrix covers connection states`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Activity states\")"))
        #expect(source.contains("private struct IPadActivityStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Connected\")"))
        #expect(source.contains("self.previewHeader(\"Loading\")"))
        #expect(source.contains("self.previewHeader(\"Empty\")"))
        #expect(source.contains("self.previewHeader(\"Error\")"))
        #expect(source.contains("title: \"Sessions unavailable\""))
        #expect(source.contains("title: \"No recent sessions\""))
        #expect(source.contains("title: \"Loading sessions\""))
    }

    @Test func `routed feature screens reuse shared pro components`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let channelsSource = try String(contentsOf: Self.channelsSourceURL(), encoding: .utf8)

        #expect(source.contains("ProMetricGrid(metrics: self.metrics)"))
        #expect(source.contains("ProPanelHeader("))
        #expect(source.contains("ProStatusRow("))
        #expect(!source.contains("private struct ProMetricGrid"))
        #expect(!source.contains("private struct ProMetric"))
        #expect(!source.contains("private struct ProPanelHeader"))
        #expect(!source.contains("private struct ProStatusRow"))
        #expect(!channelsSource.contains("private struct SettingsChannelPanelHeader"))
        #expect(!channelsSource.contains("private struct SettingsChannelInfoRow"))
        #expect(componentsSource.contains("struct ProMetricGrid"))
        #expect(componentsSource.contains("struct ProPanelHeader"))
        #expect(componentsSource.contains("struct ProStatusRow"))
    }

    @Test func `activity screen stays split from task feature screens`() throws {
        let taskSource = try Self.iPadTaskFeatureScreensSource()
        let activitySource = try String(contentsOf: Self.iPadActivityScreenSourceURL(), encoding: .utf8)
        let appModelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let projectSource = try String(contentsOf: Self.xcodeProjectSourceURL(), encoding: .utf8)

        #expect(activitySource.contains("struct IPadActivityScreen: View"))
        #expect(activitySource.contains("self.appModel.makeChatTransport()"))
        #expect(appModelSource.contains("return IOSGatewayChatTransport(gateway: self.operatorSession)"))
        #expect(activitySource.contains("IPadSidebarScreenChrome("))
        #expect(!taskSource.contains("struct IPadActivityScreen"))
        #expect(!taskSource.contains("import OpenClawChatUI"))
        #expect(projectSource.contains("IPadActivityScreen.swift in Sources"))
    }

    @Test func `routed feature chrome stays split from task feature screens`() throws {
        let taskSource = try Self.iPadTaskFeatureScreensSource()
        let chromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let projectSource = try String(contentsOf: Self.xcodeProjectSourceURL(), encoding: .utf8)

        #expect(chromeSource.contains("struct IPadSidebarScreenChrome<Content: View>: View"))
        #expect(chromeSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
        #expect(chromeSource.contains("OpenClawGatewayCompactPill()"))
        #expect(!taskSource.contains("struct IPadSidebarScreenChrome"))
        #expect(projectSource.contains("IPadSidebarScreenChrome.swift in Sources"))
    }

    @Test func `routed feature chrome keeps gateway pill actionable`() throws {
        let chromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let featureSource = try Self.iPadTaskFeatureScreensSource()
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(chromeSource.contains("let gatewayAction: (() -> Void)?"))
        #expect(chromeSource.contains("private var gatewayPill: some View"))
        #expect(chromeSource.contains("Button(action: gatewayAction)"))
        #expect(chromeSource.contains(".accessibilityHint(\"Opens Settings / Gateway\")"))
        #expect(featureSource.matches(of: /gatewayAction: self\.openSettings/).count == 2)
        #expect(rootSource.contains("IPadActivityScreen("))
        #expect(rootSource
            .matches(of: /IPadActivityScreen\([\s\S]*?openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/)
            .count == 1)
    }

    @Test func `routed gateway pills open gateway settings`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let agentSource = try String(contentsOf: Self.agentProTabSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let overviewSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let settingsTabSource = try String(contentsOf: Self.settingsProTabSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let notificationGuidanceSource = try String(
            contentsOf: Self.notificationPermissionGuidanceDialogSourceURL(),
            encoding: .utf8)

        #expect(rootSource.matches(of: /openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/).count >= 2)
        #expect(rootSource.matches(of: /gatewayAction: \{ self\.selectSidebarDestination\(\.gateway\) \}/).count == 1)
        #expect(!rootSource.contains("showGatewayActions"))
        #expect(!rootSource.contains("gatewayActionsDialog"))
        #expect(overviewSource.contains("Button(action: self.openSettings)"))
        #expect(overviewSource.contains(".accessibilityHint(\"Opens Settings / Gateway\")"))
        #expect(agentSource.contains("let openSettings: (() -> Void)?"))
        #expect(agentOverviewSource.contains("OpenClawGatewayCompactPill()"))
        #expect(agentOverviewSource.contains("Button(action: openSettings)"))
        #expect(rootSource
            .matches(of: /AgentProTab\([\s\S]*?openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/)
            .count >= 3)
        #expect(chatSource.contains("let openSettings: (() -> Void)?"))
        #expect(chatSource.contains("private var connectionPillButton: some View"))
        #expect(docsSource.contains("let gatewayAction: (() -> Void)?"))
        #expect(settingsSource.contains("NavigationLink(value: SettingsRoute.gateway)"))
        #expect(rootSource.contains("case .settings:"))
        #expect(rootSource
            .matches(
                of: /case \.settings:[\s\S]*?SettingsProTab\([\s\S]*?headerLeadingAction: self\.sidebarHeaderLeadingAction,[\s\S]*?ownsNavigationStack: false[\s\S]*?onRouteChange: self\.handleSettingsRouteChange/)
            .count >= 1)
        #expect(rootSource
            .contains(
                "directRoute: self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute ?? .gateway"))
        #expect(rootSource.contains("ownsNavigationStack: false"))
        #expect(rootSource.contains("@State private var sidebarNavigationPath: [SettingsRoute] = []"))
        #expect(rootSource.contains("NavigationStack(path: self.$sidebarNavigationPath)"))
        #expect(rootSource.contains("self.sidebarNavigationPath.removeAll()"))
        #expect(rootSource.matches(of: /SettingsProTab\(\s*initialRoute: self\.selectedSettingsRoute,/).count == 1)
        #expect(rootSource.contains(".id(self.settingsTabViewID)"))
        #expect(rootSource.contains("@State private var selectedSettingsRouteRequestID: Int = 0"))
        #expect(rootSource.contains("self.selectedSettingsRouteRequestID &+= 1"))
        #expect(rootSource.contains("@State private var suppressedExecApprovalPromptIDForNotificationSettings"))
        #expect(rootSource.contains("private var activeExecApprovalPromptSuppressionID: String?"))
        #expect(rootSource.contains("suppressedApprovalID: self.activeExecApprovalPromptSuppressionID"))
        #expect(rootSource.contains("if destination.settingsRoute != .notifications"))
        #expect(rootSource.contains("if route != .notifications"))
        #expect(rootSource.contains("if route == nil"))
        #expect(rootSource.contains("self.selectedSettingsRoute = nil"))
        #expect(rootSource.contains("self.selectedSidebarDestination = .settings"))
        #expect(rootSource.contains("self.suppressedExecApprovalPromptIDForNotificationSettings = approvalId"))
        #expect(rootSource.contains("onRouteChange: self.handleSettingsRouteChange"))
        #expect(rootSource.contains("navigateToRoute: self.pushSidebarSettingsRoute"))
        #expect(rootSource.contains("private func pushSidebarSettingsRoute(_ route: SettingsRoute)"))
        #expect(settingsTabSource.contains("let navigateToRoute: ((SettingsRoute) -> Void)?"))
        #expect(settingsTabSource.contains("navigateToRoute(.notifications)"))
        #expect(rootSource.contains("private func handleSettingsRouteChange(_ route: SettingsRoute?)"))
        #expect(settingsTabSource.contains("let onRouteChange: ((SettingsRoute?) -> Void)?"))
        #expect(settingsTabSource.contains("self.onRouteChange?(self.navigationPath.last)"))
        #expect(notificationGuidanceSource.contains("onSuppressFuture"))
        #expect(notificationGuidanceSource.contains("suppressFuture: true"))
        #expect(notificationGuidanceSource.contains("Text(\"Don't show again\")"))
        #expect(rootSource.contains("private func selectSettingsRoute(_ route: SettingsRoute)"))
        #expect(settingsSource.contains("title: \"Channels / Integrations\""))
        #expect(settingsSource.contains("route: .channels"))
        #expect(docsSource.contains(".accessibilityHint(\"Opens Settings / Gateway\")"))
    }

    @Test func `push enrollment stays behind notification disclosure flow`() throws {
        let appSource = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let modelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)

        #expect(appSource.contains("PushEnrollmentConsent.disclosureAccepted"))
        #expect(appSource.contains("await Self.isNotificationAuthorizationAllowed()"))
        #expect(actionsSource.contains("PushEnrollmentConsent.markDisclosureAccepted()"))
        #expect(actionsSource.contains("self.registerForRemoteNotificationsIfEnrollmentReady()"))
        #expect(modelSource.contains("PushEnrollmentConsent.disclosureAccepted"))
        #expect(modelSource.contains("notifications_not_authorized"))
        #expect(modelSource.contains("enrollment_disclosure_not_accepted"))
    }

    @Test func `gateway settings keeps pairing trust diagnostics and tailscale actions`() throws {
        let settingsSource = try String(contentsOf: Self.settingsProTabSourceURL(), encoding: .utf8)
        let sectionsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let trustSource = try String(contentsOf: Self.gatewayTrustPromptAlertSourceURL(), encoding: .utf8)
        let controllerSource = try String(contentsOf: Self.gatewayConnectionControllerSourceURL(), encoding: .utf8)

        #expect(sectionsSource.contains("var gatewayDestination: some View"))
        #expect(sectionsSource.contains("self.gatewayActions"))
        #expect(sectionsSource.contains("self.manualGatewayCard"))
        #expect(sectionsSource.contains("self.gatewaySetupCard"))
        #expect(sectionsSource.contains("self.discoveredGatewaysCard"))
        #expect(sectionsSource.contains("self.gatewayAdvancedCard"))
        #expect(sectionsSource.contains("title: \"Reconnect\""))
        #expect(sectionsSource.contains("Task { await self.reconnectGateway() }"))
        #expect(sectionsSource.contains("title: \"Diagnose\""))
        #expect(sectionsSource.contains("Task { await self.runDiagnostics() }"))
        #expect(sectionsSource.contains("title: \"Scan QR\""))
        #expect(sectionsSource.contains("self.openGatewayQRScanner()"))
        #expect(sectionsSource.contains("title: \"Connect\""))
        #expect(sectionsSource.contains("Task { await self.applySetupCodeAndConnect() }"))
        #expect(sectionsSource.contains("Task { await self.connect(gateway) }"))
        #expect(sectionsSource.contains("tailnetWarningText"))
        #expect(sectionsSource.contains("GatewayProblemBanner("))
        #expect(sectionsSource.contains("Task { await self.handleGatewayProblemPrimaryAction(problem) }"))

        #expect(actionsSource.contains("await self.gatewayController.connectLastKnown()"))
        #expect(actionsSource.contains("self.gatewayController.refreshActiveGatewayRegistrationFromSettings()"))
        #expect(actionsSource.contains("self.gatewayController.restartDiscovery()"))
        #expect(actionsSource.contains("await self.appModel.refreshGatewayOverviewIfConnected()"))
        #expect(actionsSource
            .contains("self.gatewayController.requestLocalNetworkAccess(reason: \"settings_preflight\")"))
        #expect(actionsSource.contains("await TCPProbe.probe(host: trimmed, port: port"))
        #expect(actionsSource.contains("Check Tailscale or LAN."))
        #expect(actionsSource.contains("Tailscale is off on this device. Turn it on, then try again."))
        #expect(actionsSource.contains("Run /pair approve in your OpenClaw chat"))
        #expect(actionsSource.contains("self.resetOnboarding()"))
        #expect(actionsSource.contains("self.gatewayController.trustRotatedGatewayCertificate(from: problem)"))
        #expect(actionsSource.contains("await self.retryGatewayConnectionFromProblem()"))

        #expect(settingsSource.contains("GatewayProblemDetailsSheet("))
        #expect(settingsSource.contains("QRScannerView("))
        #expect(trustSource.contains("Trust this gateway?"))
        #expect(trustSource.contains("Trust and connect"))
        #expect(controllerSource.contains("acceptPendingTrustPrompt()"))
        #expect(controllerSource.contains("trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem)"))
    }

    @Test func `local network access is requested from visible gateway flows`() throws {
        let appSource = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let controllerSource = try String(contentsOf: Self.gatewayConnectionControllerSourceURL(), encoding: .utf8)

        #expect(appSource.contains("deferDiscoveryUntilLocalNetworkRequest: true"))
        #expect(controllerSource.contains("func requestLocalNetworkAccess(reason: String)"))
        #expect(controllerSource.contains("guard self.localNetworkAccessRequested else"))
        #expect(controllerSource.contains("self.requestLocalNetworkAccess(reason: \"connect_manual\")"))
        #expect(controllerSource.contains("self.requestLocalNetworkAccess(reason: \"connect_discovered_gateway\")"))
        #expect(controllerSource.contains("self.requestLocalNetworkAccess(reason: \"connect_last_known\")"))

        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"root_appear\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"scene_active\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"onboarding_dismissed\")"))
        #expect(rootSource.contains("self.requestLocalNetworkAccess(reason: \"gateway_setup_deeplink\")"))
        #expect(rootSource.contains("guard self.didEvaluateOnboarding else { return }"))
        #expect(rootSource.contains("onRequestLocalNetworkAccess: { reason in"))

        #expect(onboardingSource.contains("self.requestLocalNetworkAccess(reason: \"onboarding_continue\")"))
        #expect(onboardingSource.contains("self.requestLocalNetworkAccessIfPastIntro(reason: \"onboarding_appear\")"))
        #expect(actionsSource
            .contains("self.gatewayController.requestLocalNetworkAccess(reason: \"settings_preflight\")"))
    }

    @Test func `gateway settings preview matrix covers primary states`() throws {
        let supportSource = try String(contentsOf: Self.settingsProTabSupportSourceURL(), encoding: .utf8)

        #expect(supportSource.contains("#Preview(\"Gateway settings states\")"))
        #expect(supportSource.contains("private struct SettingsGatewayStatesPreview"))
        #expect(supportSource.contains("self.stateSection(\"Connected\")"))
        #expect(supportSource.contains("self.stateSection(\"Loading\")"))
        #expect(supportSource.contains("self.stateSection(\"Empty\")"))
        #expect(supportSource.contains("self.stateSection(\"Error\")"))
        #expect(supportSource.contains("GatewayProblemBanner("))
        #expect(supportSource.contains("kind: .pairingRequired"))
        #expect(supportSource.contains("Run /pair approve in your OpenClaw chat"))
        #expect(supportSource.contains("Tailscale is off on this device. Turn it on, then try again."))
        #expect(supportSource.contains("self.previewButton(\"Scan QR\""))
        #expect(supportSource.contains("self.previewButton(\"Connect\""))
        #expect(supportSource.contains("self.previewButton(\"Reconnect\""))
        #expect(supportSource.contains("self.previewButton(\"Diagnose\""))
    }

    @Test func `native chat uses gateway transport`() throws {
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let channelsSource = try String(contentsOf: Self.channelsSourceURL(), encoding: .utf8)
        let settingsSectionsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let appModelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)

        #expect(chatSource.matches(of: /self\.appModel\.makeChatTransport\(\)/).count == 2)
        #expect(appModelSource.contains("return IOSGatewayChatTransport(gateway: self.operatorSession)"))
        #expect(settingsSectionsSource.contains("Message routing and external channel clients."))
        #expect(channelsSource.contains("\"clickclack\": SettingsChannelFallbackMetadata"))
        #expect(channelsSource.contains("label: \"ClickClack\""))
        #expect(channelsSource.contains("Self-hosted chat bot routing."))
    }

    private static func rootTabsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabs.swift")
    }

    private static func nodeAppModelSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Model/NodeAppModel.swift")
    }

    private static func phoneHubSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/RootTabsPhoneControlHub.swift")
    }

    private static func proComponentsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/OpenClawProComponents.swift")
    }

    private static func commandCenterSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/CommandCenterTab.swift")
    }

    private static func agentProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab.swift")
    }

    private static func agentProTabOverviewSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab+Overview.swift")
    }

    private static func agentProTabDestinationsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab+Destinations.swift")
    }

    private static func agentProNodesDestinationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProNodesDestination.swift")
    }

    private static func agentProDreamingDestinationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProDreamingDestination.swift")
    }

    private static func rootTabsNavigationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabsNavigation.swift")
    }

    private static func iPadSidebarFeatureScreensSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarFeatureScreens.swift")
    }

    private static func iPadTaskFeatureScreensSource() throws -> String {
        try [
            self.iPadWorkboardScreenSourceURL(),
            self.iPadSkillWorkshopScreenSourceURL(),
            self.iPadSidebarFeatureScreensSourceURL(),
        ]
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
    }

    private static func iPadWorkboardScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadWorkboardScreen.swift")
    }

    private static func iPadSkillWorkshopScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSkillWorkshopScreen.swift")
    }

    private static func iPadSidebarFeaturePreviewsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarFeaturePreviews.swift")
    }

    private static func iPadActivityScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadActivityScreen.swift")
    }

    private static func iPadSidebarScreenChromeSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarScreenChrome.swift")
    }

    private static func chatProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/ChatProTab.swift")
    }

    private static func docsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/OpenClawDocsScreen.swift")
    }

    private static func settingsProTabSectionsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabSections.swift")
    }

    private static func settingsProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTab.swift")
    }

    private static func onboardingWizardSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Onboarding/OnboardingWizardView.swift")
    }

    private static func openClawAppSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/OpenClawApp.swift")
    }

    private static func notificationPermissionGuidanceDialogSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/NotificationPermissionGuidanceDialog.swift")
    }

    private static func settingsProTabActionsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabActions.swift")
    }

    private static func settingsProTabSupportSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabSupport.swift")
    }

    private static func gatewayTrustPromptAlertSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/GatewayTrustPromptAlert.swift")
    }

    private static func gatewayConnectionControllerSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/GatewayConnectionController.swift")
    }

    private static func channelsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsChannelsDestination.swift")
    }

    private static func sharedChatPreviewSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI/ChatView+Previews.swift")
    }

    private static func xcodeProjectSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("OpenClaw.xcodeproj/project.pbxproj")
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
