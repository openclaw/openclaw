import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.rootTabsUserInterfaceIdiomOverride) private var userInterfaceIdiomOverride
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @State private var selectedTab: AppTab = Self.initialTab
    @State private var selectedSidebarDestination: SidebarDestination = Self.initialSidebarDestination
    @State private var selectedSettingsRoute: SettingsRoute? = Self.initialSidebarDestination.settingsRoute
    @State private var selectedSettingsRouteRequestID: Int = 0
    @State private var isSidebarVisible: Bool = Self.initialSidebarVisibility ?? false
    @State private var sidebarVisibilityUserOverridden: Bool = Self.initialSidebarVisibility != nil
    @State private var isSidebarDrawerLayout: Bool = false
    @State private var didResolveSidebarLayout: Bool = false
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var presentedSheet: PresentedSheet?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialAppearance: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var handledGatewaySetupRequestID: Int = 0
    @State private var suppressedExecApprovalPromptIDForNotificationSettings: String?
    @State private var activePreviewTourStep: PreviewTourStep?
    @State private var onboardingStartScreen: OnboardingWizardStartScreen = .automatic

    private static var initialTab: AppTab {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-tab") else {
            return .control
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else {
            return .control
        }

        switch arguments[valueIndex].lowercased() {
        case "chat":
            return .chat
        case "talk", "voice":
            return .talk
        case "agent", "agents":
            return .agent
        case "settings":
            return .settings
        default:
            return .control
        }
    }

    private static var initialSidebarDestination: SidebarDestination {
        if let requested = requestedInitialSidebarDestination {
            return requested
        }
        return Self.defaultSidebarDestination(for: initialTab)
    }

    private static var requestedInitialSidebarDestination: SidebarDestination? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-destination") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let requested = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return SidebarDestination.allCases.first { $0.rawValue.lowercased() == requested }
    }

    private static var initialSidebarVisibility: Bool? {
        requestedInitialSidebarVisibility(arguments: ProcessInfo.processInfo.arguments)
    }

    private static var initialChatSessionKey: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-chat-session") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let trimmed = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private enum PresentedSheet: Identifiable {
        case quickSetup

        var id: Int {
            switch self {
            case .quickSetup: 0
            }
        }
    }

    static func shouldUseSidebarTabs(
        idiom: UIUserInterfaceIdiom,
        horizontalSizeClass _: UserInterfaceSizeClass?) -> Bool
    {
        idiom == .pad
    }

    var body: some View {
        self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.tabContent
                        .tint(OpenClawBrand.accent))))
    }

    @ViewBuilder
    private var tabContent: some View {
        if self.usesSidebarTabs {
            self.sidebarSplitContent
        } else {
            self.phoneTabContent
        }
    }

    private var phoneTabContent: some View {
        TabView(selection: self.$selectedTab) {
            RootTabsPhoneControlHub(
                groups: Self.phoneControlGroups,
                initialDestination: Self.requestedInitialSidebarDestination,
                openRootDestination: { self.openRootDestination($0) },
                openSettingsRoute: { self.selectSettingsRoute($0) })
                .tabItem { Label("Control", systemImage: "square.grid.2x2") }
                .badge(self.appModel.pendingExecApprovalPrompt == nil ? 0 : 1)
                .tag(AppTab.control)

            ChatProTab(openSettings: { self.openGatewayEntryPoint() })
                .tabItem { Label("Chat", systemImage: "bubble.left.fill") }
                .tag(AppTab.chat)

            TalkProTab(openSettings: { self.openGatewayEntryPoint() })
                .tabItem {
                    Label(
                        "Talk",
                        systemImage: self.appModel.talkMode.isEnabled ? "waveform.circle.fill" : "waveform.circle")
                }
                .tag(AppTab.talk)

            NavigationStack {
                AgentProTab(
                    directRoute: .agents,
                    openSettings: { self.openGatewayEntryPoint() })
            }
            .tabItem { Label("Agent", systemImage: "person.2.fill") }
            .tag(AppTab.agent)

            SettingsProTab(
                initialRoute: self.selectedSettingsRoute,
                onRouteChange: self.handleSettingsRouteChange)
                .id(self.settingsTabViewID)
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: proxy.size)
            let sidebarWidth = self.sidebarWidth(containerWidth: proxy.size.width, isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(sidebarWidth: sidebarWidth)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .animation(.easeInOut(duration: 0.22), value: self.isSidebarVisible)
            .onAppear {
                self.updateSidebarLayout(containerSize: proxy.size, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                self.updateSidebarLayout(containerSize: size, force: false)
            }
        }
    }

    private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            if self.isSidebarVisible {
                self.sidebarColumn
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }

            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(OpenClawProBackground())
    }

    private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if self.isSidebarVisible {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        self.hideSidebar()
                    }
                    .transition(.opacity)

                self.sidebarColumn
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .shadow(color: .black.opacity(0.26), radius: 18, x: 8, y: 0)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
    }

    private var sidebarDetailShell: some View {
        self.sidebarDetail
            .id(self.sidebarDetailShellID)
    }

    private var sidebarColumn: some View {
        VStack(spacing: 0) {
            self.sidebarIdentityHeader
            self.sidebarList
            self.sidebarFooter
        }
        .safeAreaPadding(.top, 8)
        .safeAreaPadding(.bottom, 8)
        .background(Color(uiColor: .systemBackground))
    }

    private var sidebarIdentityHeader: some View {
        HStack(spacing: 10) {
            OpenClawProMark(size: 30, shadowRadius: 3)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                HStack(spacing: 4) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(self.sidebarGatewayStatusColor)
                    Text(self.sidebarGatewayStatusTitle)
                        .lineLimit(1)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if self.isSidebarDrawerLayout {
                self.sidebarHideButton
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .bottom) {
            self.sidebarHorizontalSeparator
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("OpenClaw \(self.sidebarGatewayStatusTitle)")
    }

    private var sidebarGatewayStatusTitle: String {
        switch self.gatewayStatus {
        case .connected:
            "Online"
        case .connecting:
            "Connecting"
        case .error:
            "Needs attention"
        case .disconnected:
            "Offline"
        }
    }

    private var sidebarList: some View {
        List {
            ForEach(Self.sidebarGroups) { group in
                Section(group.title.capitalized) {
                    ForEach(group.destinations) { destination in
                        self.sidebarDestinationButton(destination)
                    }
                }
                .listSectionSeparator(.hidden, edges: .all)
            }
        }
        .listStyle(.sidebar)
        .tint(OpenClawBrand.accent)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
    }

    private var sidebarFooter: some View {
        VStack(spacing: 0) {
            self.sidebarHorizontalSeparator
            HStack(spacing: 10) {
                Text("VERSION")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text("v\(DeviceInfoHelper.openClawVersionString())")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                ProStatusDot(color: self.sidebarGatewayStatusColor)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
        }
    }

    private var sidebarHorizontalSeparator: some View {
        Rectangle()
            .fill(Color(uiColor: .separator))
            .frame(height: 1 / UIScreen.main.scale)
    }

    private var sidebarVerticalSeparator: some View {
        Rectangle()
            .fill(Color(uiColor: .separator))
            .frame(width: 1 / UIScreen.main.scale)
    }

    private var sidebarGatewayStatusColor: Color {
        switch self.gatewayStatus {
        case .connected:
            OpenClawBrand.ok
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private func sidebarDestinationButton(
        _ destination: SidebarDestination,
        title: String? = nil) -> some View
    {
        Button {
            self.openRootDestination(destination)
        } label: {
            Label(title ?? destination.sidebarTitle, systemImage: destination.systemImage)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .foregroundStyle(destination == self.selectedSidebarDestination ? OpenClawBrand.accent : .primary)
        .listRowBackground(
            destination == self.selectedSidebarDestination
                ? OpenClawBrand.accent.opacity(0.12)
                : Color.clear)
        .listRowSeparator(.hidden, edges: .all)
    }

    @ViewBuilder
    private var sidebarDetail: some View {
        switch self.selectedSidebarDestination {
        case .chat:
            ChatProTab(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Chat",
                headerSubtitle: "Agent conversation",
                showsAgentBadge: false,
                openSettings: { self.openGatewayEntryPoint() })
        case .talk:
            TalkProTab(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openSettings: { self.openGatewayEntryPoint() })
        case .overview:
            CommandCenterTab(
                headerTitle: "Overview",
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                showsHeaderMark: false,
                ownsNavigationStack: false,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.openGatewayEntryPoint() },
                openSessions: { self.selectSidebarDestination(.sessions) })
        case .activity:
            IPadActivityScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.openGatewayEntryPoint() },
                openApprovals: { self.selectSettingsRoute(.approvals) })
        case .workboard:
            IPadWorkboardScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.openGatewayEntryPoint() })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openSettings: { self.openGatewayEntryPoint() })
        case .agents:
            AgentProTab(
                directRoute: .agents,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Agents",
                openSettings: { self.openGatewayEntryPoint() })
                .id(self.selectedSidebarDestination.id)
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Instances",
                openSettings: { self.openGatewayEntryPoint() })
                .id(self.selectedSidebarDestination.id)
        case .sessions:
            CommandSessionsScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) })
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Dreaming",
                openSettings: { self.openGatewayEntryPoint() })
                .id(self.selectedSidebarDestination.id)
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Usage",
                openSettings: { self.openGatewayEntryPoint() })
                .id(self.selectedSidebarDestination.id)
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Cron Jobs",
                openSettings: { self.openGatewayEntryPoint() })
                .id(self.selectedSidebarDestination.id)
        case .docs:
            OpenClawDocsScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                gatewayAction: { self.openGatewayEntryPoint() })
        case .settings:
            if let selectedSettingsRoute {
                SettingsProTab(
                    directRoute: selectedSettingsRoute,
                    headerLeadingAction: self.sidebarHeaderLeadingAction,
                    onRouteChange: self.handleSettingsRouteChange)
            } else {
                SettingsProTab(
                    headerLeadingAction: self.sidebarHeaderLeadingAction,
                    onRouteChange: self.handleSettingsRouteChange)
            }
        case .gateway:
            SettingsProTab(
                directRoute: self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute ?? .gateway,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                onRouteChange: self.handleSettingsRouteChange)
        }
    }

    private var sidebarDetailNavigationShell: some View {
        NavigationStack {
            self.sidebarDetailShell
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }

    private var usesSidebarTabs: Bool {
        Self.shouldUseSidebarTabs(
            idiom: self.userInterfaceIdiom,
            horizontalSizeClass: self.horizontalSizeClass)
    }

    private var userInterfaceIdiom: UIUserInterfaceIdiom {
        if let userInterfaceIdiomOverride {
            return userInterfaceIdiomOverride
        }
        return UIDevice.current.userInterfaceIdiom
    }

    private var sidebarDetailShellID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "root"
        return "\(self.selectedSidebarDestination.id):\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var settingsTabViewID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "settings"
        return "\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var activeExecApprovalPromptSuppressionID: String? {
        guard self.selectedTab == .settings, self.selectedSettingsRoute == .notifications else { return nil }
        return self.suppressedExecApprovalPromptIDForNotificationSettings
    }

    private var shouldCollapseSidebarAfterSelection: Bool {
        Self.shouldCollapseSidebarAfterSelection(
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
    }

    private var sidebarHeaderLeadingAction: OpenClawSidebarHeaderAction? {
        guard Self.shouldShowSidebarRevealInDestinationHeader(
            isSidebarVisible: self.isSidebarVisible,
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
        else {
            return nil
        }
        if self.isSidebarVisible {
            return OpenClawSidebarHeaderAction(
                systemName: "sidebar.left",
                accessibilityLabel: "Hide Sidebar",
                accessibilityIdentifier: Self.sidebarHideButtonAccessibilityIdentifier,
                action: { self.hideSidebar() })
        }
        return OpenClawSidebarHeaderAction(
            systemName: "sidebar.left",
            accessibilityLabel: "Show Sidebar",
            accessibilityIdentifier: Self.sidebarShowButtonAccessibilityIdentifier,
            action: { self.showSidebar() })
    }

    private var sidebarHideButton: some View {
        Button {
            self.hideSidebar()
        } label: {
            Image(systemName: self.isSidebarDrawerLayout ? "xmark" : "sidebar.left")
                .font(.system(size: 15, weight: .semibold))
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawBrand.accent)
        .accessibilityLabel("Hide Sidebar")
        .accessibilityIdentifier(Self.sidebarHideButtonAccessibilityIdentifier)
    }

    private func shouldUseSidebarDrawer(containerSize: CGSize) -> Bool {
        Self.sidebarLayoutMode(containerSize: containerSize) == .drawer
    }

    private func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        Self.sidebarWidth(containerWidth: containerWidth, isDrawerLayout: isDrawerLayout)
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .bottom) {
                if self.appModel.isAppleReviewDemoModeEnabled,
                   let activePreviewTourStep = self.activePreviewTourStep
                {
                    RootTabsPreviewTourCard(
                        step: activePreviewTourStep,
                        nextTitle: activePreviewTourStep.next == nil ? "Set up Gateway" : "Next",
                        onNext: { self.advancePreviewTour() },
                        onSkip: { self.endPreviewTour() })
                        .padding(.horizontal, 14)
                        .safeAreaPadding(.bottom, 74)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .overlay(alignment: .top) {
                if let gatewayProblem = self.appModel.lastGatewayProblem,
                   self.gatewayStatus != .connected
                {
                    GatewayProblemBanner(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem)
                        },
                        onShowDetails: {
                            self.showGatewayProblemDetails = true
                        })
                        .padding(.horizontal, 12)
                        .safeAreaPadding(.top, 10)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(.top, self.appModel.lastGatewayProblem == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            .overlay {
                if self.appModel.cameraFlashNonce != 0 {
                    RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
                }
            }
            .overlay {
                if self.appModel.screen.isCanvasPresented {
                    self.canvasPresentationOverlay
                        .transition(.opacity)
                        .zIndex(20)
                }
            }
    }

    private var canvasPresentationOverlay: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ScreenWebView(controller: self.appModel.screen)
                .ignoresSafeArea()
            Button {
                self.appModel.screen.hideCanvas()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.32), radius: 8, y: 2)
                    .frame(width: 48, height: 48)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close canvas")
            .safeAreaPadding(.top, 8)
            .padding(.trailing, 12)
        }
    }

    private func rootLifecycle(_ content: some View) -> some View {
        self.rootRequestLifecycle(
            self.rootGatewayLifecycle(
                self.rootAppearLifecycle(
                    self.rootVoiceWakeLifecycle(content))))
    }

    private func rootVoiceWakeLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
                guard let newValue else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }

                self.toastDismissTask?.cancel()
                withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                    self.voiceWakeToastText = trimmed
                }

                self.toastDismissTask = Task {
                    try? await Task.sleep(nanoseconds: 2_300_000_000)
                    await MainActor.run {
                        withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                            self.voiceWakeToastText = nil
                        }
                    }
                }
            }
    }

    private func rootAppearLifecycle(_ content: some View) -> some View {
        content
            .onAppear { self.updateIdleTimer() }
            .onAppear { self.updateCanvasState() }
            .onAppear { self.evaluateOnboardingPresentation(force: false) }
            .onAppear { self.maybeAutoOpenSettings() }
            .onAppear { self.maybeOpenSettingsForGatewaySetup() }
            .onAppear { self.maybeShowQuickSetup() }
            .onAppear { self.applyInitialAppearanceIfNeeded() }
            .onAppear { self.applyInitialChatSessionIfNeeded() }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                self.updateHomeCanvasState()
                guard newValue == .active else { return }
                self.maybeRequestLocalNetworkAccess(reason: "scene_active")
                Task {
                    await self.appModel.refreshGatewayOverviewIfConnected()
                    await MainActor.run {
                        self.updateHomeCanvasState()
                    }
                }
            }
            .onDisappear {
                UIApplication.shared.isIdleTimerDisabled = false
                self.toastDismissTask?.cancel()
                self.toastDismissTask = nil
            }
    }

    private func rootGatewayLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if OnboardingStateStore.shouldMarkCompleted(
                    gatewayServerName: newValue,
                    isLocalGatewayFixtureEnabled: self.appModel.isLocalGatewayFixtureEnabled)
                {
                    self.onboardingComplete = true
                    self.hasConnectedOnce = true
                    OnboardingStateStore.markCompleted(mode: nil)
                }
                self.maybeAutoOpenSettings()
                self.maybeShowQuickSetup()
                self.updateCanvasState()
            }
            .onChange(of: self.appModel.gatewayStatusText) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.gatewayRemoteAddress) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.gatewayDisplayStatusText) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.homeCanvasRevision) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.gatewayAgents.count) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.selectedAgentId) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.gatewayDefaultAgentId) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.activeAgentName) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.connectedGatewayID) { _, _ in
                self.updateCanvasState()
            }
    }

    private func rootRequestLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.onboardingRequestID) { _, _ in
                self.evaluateOnboardingPresentation(force: true)
            }
            .onChange(of: self.showOnboarding) { _, newValue in
                guard !newValue else { return }
                self.maybeRequestLocalNetworkAccess(reason: "onboarding_dismissed")
            }
            .onChange(of: self.appModel.openChatRequestID) { _, _ in
                self.selectSidebarDestination(.chat)
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                self.maybeOpenSettingsForGatewaySetup()
            }
            .onChange(of: self.appModel.pendingExecApprovalPrompt?.id) { _, newValue in
                if newValue != self.suppressedExecApprovalPromptIDForNotificationSettings {
                    self.suppressedExecApprovalPromptIDForNotificationSettings = nil
                }
            }
    }

    private func rootPresentation(_ content: some View) -> some View {
        content
            .sheet(isPresented: self.$showGatewayProblemDetails) {
                if let gatewayProblem = self.appModel.lastGatewayProblem {
                    GatewayProblemDetailsSheet(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem)
                        })
                }
            }
            .sheet(item: self.$presentedSheet) { sheet in
                switch sheet {
                case .quickSetup:
                    GatewayQuickSetupSheet()
                        .environment(self.appModel)
                        .environment(self.gatewayController)
                        .openClawSheetChrome()
                        .preferredColorScheme(self.appearancePreference.colorScheme)
                }
            }
            .fullScreenCover(isPresented: self.$showOnboarding) {
                OnboardingWizardView(
                    allowSkip: self.onboardingAllowSkip,
                    startScreen: self.onboardingStartScreen,
                    onRequestLocalNetworkAccess: { reason in
                        self.requestLocalNetworkAccess(reason: reason)
                    },
                    onClose: { reason in
                        OnboardingStateStore.markFirstRunIntroSeen()
                        self.onboardingStartScreen = .automatic
                        self.showOnboarding = false
                        switch reason {
                        case .dismissed:
                            break
                        case .explore:
                            self.startPreviewTour()
                        }
                    })
                    .environment(self.appModel)
                    .environment(self.voiceWake)
                    .environment(self.gatewayController)
                    .preferredColorScheme(self.appearancePreference.colorScheme)
            }
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .execApprovalPromptDialog(
                suppressedApprovalID: self.activeExecApprovalPromptSuppressionID)
            .notificationPermissionGuidanceDialog(openNotifications: { approvalId in
                self.suppressedExecApprovalPromptIDForNotificationSettings = approvalId
                self.selectSettingsRoute(.notifications)
            })
    }

    private var appearancePreference: AppAppearancePreference {
        AppAppearancePreference.launchArgumentPreference
            ?? AppAppearancePreference(rawValue: self.appearancePreferenceRaw)
            ?? .system
    }

    private var gatewayStatus: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }

    private func updateCanvasState() {
        self.updateHomeCanvasState()
        self.updateCanvasDebugStatus()
    }

    private func updateCanvasDebugStatus() {
        self.appModel.screen.setDebugStatusEnabled(self.canvasDebugStatusEnabled)
        guard self.canvasDebugStatusEnabled else { return }
        let title = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = self.appModel.gatewayServerName ?? self.appModel.gatewayRemoteAddress
        self.appModel.screen.updateDebugStatus(title: title, subtitle: subtitle)
    }

    private func updateHomeCanvasState() {
        let payload = self.makeHomeCanvasPayload()
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else {
            self.appModel.screen.updateHomeCanvasState(json: nil)
            return
        }
        self.appModel.screen.updateHomeCanvasState(json: json)
    }

    private func makeHomeCanvasPayload() -> RootTabsHomeCanvasPayload {
        let gatewayName = self.normalized(self.appModel.gatewayServerName)
        let gatewayAddress = self.normalized(self.appModel.gatewayRemoteAddress)
        let gatewayLabel = gatewayName ?? gatewayAddress ?? "Gateway"
        let activeAgentID = self.resolveActiveAgentID()
        let agents = self.homeCanvasAgents(activeAgentID: activeAgentID)

        switch self.gatewayStatus {
        case .connected:
            return RootTabsHomeCanvasPayload(
                gatewayState: "connected",
                eyebrow: "\(gatewayLabel) online",
                title: "Command center",
                subtitle:
                "Use Chat for code work, Talk for realtime voice, and gateway tools for approved device actions.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Routes chat and talk",
                agentCount: agents.count,
                agents: Array(agents.prefix(6)),
                footer: "OpenClaw only runs phone-side capabilities while the app is connected and permitted.")
        case .connecting:
            return RootTabsHomeCanvasPayload(
                gatewayState: "connecting",
                eyebrow: "Gateway handshake",
                title: "Reconnecting",
                subtitle:
                "Restoring the local node session, agent list, voice config, and device capability state.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: "OC",
                activeAgentCaption: "Session in progress",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "If the gateway is reachable, the local node should recover without re-pairing.")
        case .error, .disconnected:
            return RootTabsHomeCanvasPayload(
                gatewayState: self.gatewayStatus == .error ? "error" : "offline",
                eyebrow: self.gatewayStatus == .error ? "Gateway needs attention" : "OpenClaw iOS",
                title: "Pair a gateway",
                subtitle:
                "Connect this phone as a local node for chat, realtime voice, share intake, and approved device tools.",
                gatewayLabel: gatewayLabel,
                activeAgentName: "Main",
                activeAgentBadge: "OC",
                activeAgentCaption: "Connect to load your agents",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer:
                "Use Settings to scan a pairing QR code or paste a setup code from your OpenClaw gateway.")
        }
    }

    private func resolveActiveAgentID() -> String {
        let selected = self.normalized(self.appModel.selectedAgentId) ?? ""
        if !selected.isEmpty {
            return selected
        }
        return self.resolveDefaultAgentID()
    }

    private func resolveDefaultAgentID() -> String {
        self.normalized(self.appModel.gatewayDefaultAgentId) ?? ""
    }

    private func homeCanvasAgents(activeAgentID: String) -> [RootTabsHomeCanvasAgentCard] {
        let defaultAgentID = self.resolveDefaultAgentID()
        let cards = self.appModel.gatewayAgents.map { agent -> RootTabsHomeCanvasAgentCard in
            let isActive = !activeAgentID.isEmpty && agent.id == activeAgentID
            let isDefault = !defaultAgentID.isEmpty && agent.id == defaultAgentID
            return RootTabsHomeCanvasAgentCard(
                id: agent.id,
                name: self.homeCanvasName(for: agent),
                badge: self.homeCanvasBadge(for: agent),
                caption: isActive ? "Routed on this phone" : (isDefault ? "Gateway default" : "Available"),
                isActive: isActive)
        }

        return cards.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive {
                return lhs.isActive
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private func homeCanvasName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }
}

extension RootTabs {
    private func openRootDestination(_ destination: SidebarDestination) {
        if destination == .gateway {
            self.openGatewayEntryPoint()
        } else {
            self.selectSidebarDestination(destination)
        }
    }

    private func openGatewayEntryPoint(startScreen: OnboardingWizardStartScreen = .automatic) {
        let route = Self.gatewayEntryPresentationRoute(
            gatewayConnected: self.appModel.isOperatorGatewayConnected,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            isPreviewMode: self.appModel.isAppleReviewDemoModeEnabled)

        switch route {
        case .gateway:
            self.selectSidebarDestination(.gateway)
            return
        case .onboarding:
            break
        }

        self.presentedSheet = nil
        self.showGatewayProblemDetails = false
        self.onboardingAllowSkip = true
        self.onboardingStartScreen = startScreen
        self.showOnboarding = true
    }

    private func selectSidebarDestination(_ destination: SidebarDestination) {
        if destination.settingsRoute != .notifications {
            self.suppressedExecApprovalPromptIDForNotificationSettings = nil
        }
        self.selectedSidebarDestination = destination
        self.selectedSettingsRoute = destination.settingsRoute
        self.selectedTab = destination.appTab
        guard self.usesSidebarTabs, self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(false)
        }
    }

    private func selectSettingsRoute(_ route: SettingsRoute) {
        if route != .notifications {
            self.suppressedExecApprovalPromptIDForNotificationSettings = nil
        }
        self.selectedSettingsRoute = route
        self.selectedSettingsRouteRequestID &+= 1
        self.selectedSidebarDestination = .settings
        self.selectedTab = .settings
        guard self.usesSidebarTabs, self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(false)
        }
    }

    private func handleSettingsRouteChange(_ route: SettingsRoute?) {
        guard route != .notifications else { return }
        if route == nil {
            self.selectedSettingsRoute = nil
            if self.selectedTab == .settings {
                self.selectedSidebarDestination = .settings
            }
        }
        self.suppressedExecApprovalPromptIDForNotificationSettings = nil
    }

    private func startPreviewTour() {
        self.setPreviewTourStep(.chat)
    }

    private func advancePreviewTour() {
        guard let activePreviewTourStep else { return }
        guard let nextStep = activePreviewTourStep.next else {
            self.endPreviewTour()
            self.openGatewayEntryPoint(startScreen: .setupGateway)
            return
        }
        self.setPreviewTourStep(nextStep)
    }

    private func endPreviewTour() {
        self.activePreviewTourStep = nil
    }

    private func setPreviewTourStep(_ step: PreviewTourStep) {
        self.activePreviewTourStep = step
        switch step {
        case .chat:
            self.selectSidebarDestination(.chat)
        case .talk:
            self.selectSidebarDestination(.talk)
        case .approvals:
            self.selectSettingsRoute(.approvals)
        }
    }

    private func showSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(true)
        }
    }

    private func hideSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(false)
        }
    }

    private func updateSidebarLayout(containerSize: CGSize, force: Bool) {
        let layoutMode = Self.sidebarLayoutMode(containerSize: containerSize)
        let previousLayoutMode: SidebarLayoutMode = self.isSidebarDrawerLayout ? .drawer : .split
        let didResolvePreviousLayout = self.didResolveSidebarLayout
        let layoutModeDidChange = layoutMode != previousLayoutMode
        self.didResolveSidebarLayout = true
        self.isSidebarDrawerLayout = layoutMode == .drawer
        if layoutModeDidChange && didResolvePreviousLayout {
            self.sidebarVisibilityUserOverridden = false
        }
        guard force || !self.sidebarVisibilityUserOverridden else { return }

        let preferredVisibility = Self.preferredSidebarVisibility(layoutMode: layoutMode)
        guard self.isSidebarVisible != preferredVisibility else { return }
        self.setSidebarVisible(preferredVisibility)
    }

    private func setSidebarVisible(_ isVisible: Bool) {
        self.isSidebarVisible = isVisible
    }

    private func homeCanvasBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.homeCanvasName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        if !initials.isEmpty {
            return initials.uppercased()
        }
        return "OC"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.canTrustRotatedCertificate { return "Trust certificate" }
        return problem.retryable ? "Retry" : "Open Settings"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) {
        if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if problem.retryable {
            Task { await self.gatewayController.connectLastKnown() }
        } else {
            self.selectSidebarDestination(.gateway)
        }
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.onboardingStartScreen = .setupGateway
            self.showOnboarding = true
            return
        }

        guard !self.didEvaluateOnboarding else { return }
        self.didEvaluateOnboarding = true
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: OnboardingStateStore.shouldPresentOnLaunch(appModel: self.appModel))
        switch route {
        case .none:
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        case .onboarding:
            self.onboardingAllowSkip = true
            self.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.selectSidebarDestination(.gateway)
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.loadLastGatewayConnection() != nil { return true }

        let preferredStableID = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferredStableID.isEmpty { return true }

        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func maybeAutoOpenSettings() {
        guard !self.didAutoOpenSettings else { return }
        guard !self.showOnboarding else { return }
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        self.maybeRequestLocalNetworkAccess(reason: "auto_open_settings")
    }

    private func maybeOpenSettingsForGatewaySetup() {
        let requestID = self.appModel.gatewaySetupRequestID
        guard requestID != 0, requestID != self.handledGatewaySetupRequestID else { return }
        self.handledGatewaySetupRequestID = requestID
        self.showOnboarding = false
        self.presentedSheet = nil
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        self.requestLocalNetworkAccess(reason: "gateway_setup_deeplink")
    }

    private func maybeRequestLocalNetworkAccess(reason: String) {
        guard self.didEvaluateOnboarding else { return }
        guard self.scenePhase == .active else { return }
        guard !self.showOnboarding else { return }
        guard self.hasConnectedOnce || self.onboardingComplete || self.hasExistingGatewayConfig() else {
            return
        }
        self.requestLocalNetworkAccess(reason: reason)
    }

    private func requestLocalNetworkAccess(reason: String) {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.gatewayController.requestLocalNetworkAccess(reason: reason)
    }

    private func applyInitialChatSessionIfNeeded() {
        guard !self.didApplyInitialChatSession else { return }
        self.didApplyInitialChatSession = true
        self.appModel.focusChatSession(Self.initialChatSessionKey)
    }

    private func applyInitialAppearanceIfNeeded() {
        guard !self.didApplyInitialAppearance else { return }
        self.didApplyInitialAppearance = true
        guard let preference = AppAppearancePreference.launchArgumentPreference else { return }
        self.appearancePreferenceRaw = preference.rawValue
    }

    private func maybeShowQuickSetup() {
        let shouldPresent = Self.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.showOnboarding,
            hasPresentedSheet: self.presentedSheet != nil,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.presentedSheet = .quickSetup
    }
}

private struct RootTabsHomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var gatewayLabel: String
    var activeAgentName: String
    var activeAgentBadge: String
    var activeAgentCaption: String
    var agentCount: Int
    var agents: [RootTabsHomeCanvasAgentCard]
    var footer: String
}

private struct RootTabsHomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}

private enum PreviewTourStep: CaseIterable {
    case chat
    case talk
    case approvals

    var index: Int {
        Self.allCases.firstIndex(of: self).map { $0 + 1 } ?? 1
    }

    var next: Self? {
        let allCases = Self.allCases
        guard let currentIndex = allCases.firstIndex(of: self) else { return nil }
        let nextIndex = allCases.index(after: currentIndex)
        guard allCases.indices.contains(nextIndex) else { return nil }
        return allCases[nextIndex]
    }

    var title: String {
        switch self {
        case .chat:
            "Chat with agents"
        case .talk:
            "See voice controls"
        case .approvals:
            "Review approvals"
        }
    }

    var detail: String {
        switch self {
        case .chat:
            "Sample chat shows how a Gateway-backed agent can keep context moving from your phone."
        case .talk:
            "Talk shows where realtime voice lives once a Gateway provides the needed voice session."
        case .approvals:
            "Approvals are examples only here. Pair a Gateway before OpenClaw can approve real actions."
        }
    }
}

private struct RootTabsPreviewTourCard: View {
    let step: PreviewTourStep
    let nextTitle: String
    let onNext: () -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Preview \(self.step.index) of \(PreviewTourStep.allCases.count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OpenClawBrand.accent)
                Spacer(minLength: 12)
                Button("Skip") {
                    self.onSkip()
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(self.step.title)
                    .font(.headline)
                Text(self.step.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                self.onNext()
            } label: {
                Text(self.nextTitle)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.1), radius: 14, y: 6)
        .frame(maxWidth: 430)
    }
}

private struct RootCameraFlashOverlay: View {
    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var task: Task<Void, Never>?

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                self.task?.cancel()
                self.task = Task { @MainActor in
                    withAnimation(.easeOut(duration: 0.08)) {
                        self.opacity = 0.85
                    }
                    try? await Task.sleep(nanoseconds: 110_000_000)
                    withAnimation(.easeOut(duration: 0.32)) {
                        self.opacity = 0
                    }
                }
            }
            .onDisappear {
                self.task?.cancel()
                self.task = nil
            }
    }
}

extension EnvironmentValues {
    @Entry var rootTabsUserInterfaceIdiomOverride: UIUserInterfaceIdiom?
}

#if DEBUG
#Preview(
    "Shell iPhone portrait",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone)
}

#Preview(
    "Shell iPhone connected",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone, gatewayState: .connected)
}

#Preview(
    "Shell iPhone gateway error",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone, gatewayState: .error)
}

#Preview(
    "Shell iPhone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .phone)
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

#Preview(
    "Shell iPad portrait drawer",
    traits: .fixedLayout(width: 1024, height: 1366),
    .portrait)
{
    RootTabsPreviewHost(idiom: .pad)
}

#Preview(
    "Shell iPad landscape split",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .connected)
}

#Preview(
    "Shell iPad connecting",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .connecting)
}

#Preview(
    "Shell iPad gateway error",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .error)
}

private struct RootTabsPreviewHost: View {
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    private let idiom: UIUserInterfaceIdiom

    init(idiom: UIUserInterfaceIdiom, gatewayState: RootTabsPreviewGatewayState = .offline) {
        let appModel = NodeAppModel()
        gatewayState.apply(to: appModel)
        self.idiom = idiom
        _appModel = State(initialValue: appModel)
        _gatewayController = State(
            initialValue: GatewayConnectionController(appModel: appModel, startDiscovery: false))
    }

    var body: some View {
        RootTabs()
            .environment(self.appModel)
            .environment(self.appModel.voiceWake)
            .environment(self.gatewayController)
            .environment(\.rootTabsUserInterfaceIdiomOverride, self.idiom)
    }
}

private enum RootTabsPreviewGatewayState {
    case offline
    case connecting
    case connected
    case error

    @MainActor
    func apply(to appModel: NodeAppModel) {
        switch self {
        case .offline:
            break
        case .connecting:
            appModel.gatewayStatusText = "Connecting..."
        case .connected:
            appModel.enterAppleReviewDemoMode()
        case .error:
            appModel.gatewayStatusText = "Gateway error: connection refused"
        }
    }
}

#endif
