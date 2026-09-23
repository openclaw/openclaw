import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(NativeActionRouter.self) private var nativeActions: NativeActionRouter?
    #if DEBUG && OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF
    @Environment(InstalledNativeActionProofHost.self) private var installedNativeProof: InstalledNativeActionProofHost?
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var sidebarModel = RootSidebarModel()
    @State private var voiceWakeToastText: String?
    @State private var toastDismissGate = DelayedActionGate()
    @State private var gatewayToastDragOffset: CGFloat = 0
    @State private var gatewayRetryFailure: String?
    // Swipe-up hides the toast only until the next problem report.
    @State private var isGatewayToastSwipeDismissed: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var gatewaySetupRequest: GatewaySetupRequest?
    @State private var nativeLifetime = IOSNativePresentationLifetime()

    @State private var presentation: RootTabsPresentationState

    init(
        initialSidebarVisibility: Bool? = nil,
        presentation: RootTabsPresentationState? = nil)
    {
        _presentation = State(initialValue: presentation ?? RootTabsPresentationState(
            initialDestination: Self.initialSidebarDestination,
            initialSidebarVisibility: initialSidebarVisibility ?? Self.initialSidebarVisibility))
    }

    private var actions: RootTabsPresentationState.Actions {
        .init(
            state: self.presentation,
            appModel: self.appModel,
            nativeActions: self.nativeActions,
            gatewayController: self.gatewayController,
            sidebarAnimation: self.sidebarAnimation)
    }

    private static var initialSidebarDestination: SidebarDestination {
        initialDestination(arguments: ProcessInfo.processInfo.arguments)
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

    private var chatPresentation: IOSChatViewModelOwner.Presentation {
        .init(
            binding: self.presentation.nativeChatBinding,
            router: self.nativeActions,
            id: self.presentation.nativePresentationID)
    }

    var body: some View {
        let newChat = self.appModel.chatPresentation.currentNewChatRequest(
            appModel: self.appModel,
            presentation: self.chatPresentation)
        return self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.sidebarSplitContent
                        .tint(OpenClawBrand.accent))))
            .environment(\.userNavigationAction, self.actions.navigationAction())
            .background(IOSNativePresentationAnchor(lifetime: self.nativeLifetime).frame(width: 0, height: 0))
            .onChange(of: self.actions.currentChatModalScope, initial: true) { _, _ in
                self.actions.synchronizeChatModalScope()
            }
            .overlay(alignment: .topLeading) {
                self.uiTestReadinessMarker
                #if DEBUG && OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF
                if let installedNativeProof {
                    Color.clear.frame(width: 1, height: 1)
                        .allowsHitTesting(false)
                        .accessibilityElement(children: .ignore)
                        .accessibilityIdentifier("RootTabs.InstalledNativeProof")
                        .accessibilityLabel(Text(verbatim: "Installed native action observation"))
                        .accessibilityValue(installedNativeProof.accessibilityValue(
                            idleUnprotectedComposer: self.appModel.chatPresentation
                                .isCurrent(appModel: self.appModel) &&
                                self.appModel.chatPresentation.viewModel?.canPreserveIdleTextDraft == true &&
                                !self.appModel.chatPresentation.hasProtectedComposer(appModel: self.appModel)))
                }
                #endif
            }
            .task(id: self.appModel.chatPresentation.taskIdentity(
                appModel: self.appModel,
                nativeBinding: self.presentation.nativeChatBinding,
                presentationID: self.presentation.nativePresentationID,
                chatRegistrationID: self.nativeActions?.chatRegistrationID,
                // Same-root navigation retires suspended work without changing its target.
                // Wake the current selection instead of leaving only the rejected task.
                presentationAuthority: self.nativeActions?
                    .capturePresentationAuthority(self.presentation.nativePresentationID)))
            {
                await self.appModel.chatPresentation.synchronizePresentation(
                    appModel: self.appModel,
                    currentPresentation: { self.chatPresentation })
            }
            .task(id: newChat.map(ObjectIdentifier.init)) {
                    guard let newChat else { return }
                    await self.appModel.chatPresentation.performNewChat(
                        newChat,
                        appModel: self.appModel,
                        currentPresentation: { self.chatPresentation })
                }
    }

    @ViewBuilder
    private var uiTestReadinessMarker: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openclaw-ui-test-readiness") {
            let readiness = self.scenePhase == .active ? "ready" : "inactive"
            let destination = self.presentation.selectedSidebarDestination.rawValue
            Color.clear
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("RootTabs.Ready")
                .accessibilityLabel(Text(verbatim: "OpenClaw test readiness"))
                .accessibilityValue("\(readiness):\(destination)")
        }
        #endif
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            // Keyboard safe-area changes must not masquerade as window/orientation changes;
            // switching layouts destroys the focused detail subtree.
            let layoutContainerSize = Self.sidebarLayoutContainerSize(
                contentSize: proxy.size,
                windowSize: self.foregroundKeyWindowSize())
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: layoutContainerSize)
            let sidebarWidth = self.sidebarWidth(
                containerWidth: layoutContainerSize.width,
                isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(
                        sidebarWidth: sidebarWidth,
                        safeAreaInsets: proxy.safeAreaInsets)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .onAppear {
                self.actions.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                let layoutContainerSize = Self.sidebarLayoutContainerSize(
                    contentSize: size,
                    windowSize: self.foregroundKeyWindowSize())
                self.actions.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            // Single refresh owner: identity/session changes, scene activation,
            // and the periodic attention refresh all land here.
            .task(id: self.sidebarRefreshID) {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.refresh(appModel: self.appModel)
                await self.appModel.refreshPendingApprovalInbox()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(600))
                    guard !Task.isCancelled else { return }
                    await self.sidebarModel.refresh(appModel: self.appModel)
                    await self.appModel.refreshPendingApprovalInbox()
                }
            }
            .task(id: "\(self.sidebarRefreshID):events") {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.observeSessionEvents(appModel: self.appModel)
            }
            .task(id: self.sessionObserverTaskIdentity) {
                await self.sidebarModel.setSessionObserverVisibility(
                    appModel: self.appModel,
                    visible: self.sessionObserverTaskIdentity.isObserverVisible)
            }
        }
    }

    private var sessionObserverTaskIdentity: SessionObserverTaskIdentity {
        SessionObserverTaskIdentity(
            sidebarRefreshID: self.sidebarRefreshID,
            isSceneActive: self.scenePhase == .active,
            isSidebarVisible: self.presentation.isSidebarVisible)
    }

    private var sidebarRefreshID: String {
        [
            self.appModel.chatViewModelIdentityID,
            self.appModel.chatSessionKey,
            String(self.appModel.operatorAuthorityGeneration),
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            if self.presentation.isSidebarVisible {
                self.sidebarColumn()
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .transition(self.sidebarTransition)
            }

            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(OpenClawProBackground())
        .animation(self.sidebarAnimation, value: self.presentation.isSidebarVisible)
    }

    private func sidebarDrawerContent(
        sidebarWidth: CGFloat,
        safeAreaInsets: EdgeInsets) -> some View
    {
        RootSidebarDrawer(
            sidebarWidth: sidebarWidth,
            isPresented: self.presentation.isSidebarVisible,
            canOpenFromEdge: self.presentation.isSidebarDetailRootVisible && self.presentation.sidebarNavigationPath
                .isEmpty,
            reduceMotion: self.reduceMotion,
            animation: self.sidebarAnimation,
            onShow: self.actions.showSidebar,
            onHide: self.actions.hideSidebar,
            sidebar: self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets),
            detail: self.sidebarDetailNavigationShell)
    }

    private var sidebarDetailShell: some View {
        let shellID = self.presentation.sidebarDetailShellID
        return self.sidebarDetail
            .environment(\.userNavigationAction, self.actions.navigationAction(detail: true))
            .id(shellID)
            // Destination-style links replace this root inside the shared stack;
            // the Settings hub owns its stack and reports typed pushes through the path.
            .onAppear {
                guard self.presentation.sidebarDetailShellID == shellID else { return }
                self.presentation.isSidebarDetailRootVisible = true
            }
            .onDisappear {
                guard self.presentation.sidebarDetailShellID == shellID else { return }
                self.presentation.isSidebarDetailRootVisible = false
            }
    }

    /// RootSidebar owns its dark surface; this wrapper only restores vertical
    /// insets. Drawer mode goes full-bleed (ignoresSafeArea) so the captured
    /// insets are re-applied manually; split mode keeps system safe areas.
    private func sidebarColumn(drawerSafeAreaInsets: EdgeInsets? = nil) -> some View {
        let action = self.actions.navigationAction()
        return RootSidebar(
            model: self.sidebarModel,
            pagesEditor: self.actions.userModalBinding(self.$presentation.pagesEditor),
            selectedDestination: self.presentation.selectedSidebarDestination,
            isDrawerLayout: self.presentation.isSidebarDrawerLayout,
            isDismissButtonEnabled: self.presentation.isSidebarVisible,
            isPagesEditorRootCurrent: self.actions.navigationContext(),
            selectDestination: { destination in
                guard action() else { return }
                self.actions.selectSidebarDestination(destination)
            },
            selectSession: { session in
                guard action() else { return }
                self.actions.selectSidebarSession(session)
            },
            openChat: self.actions.openChatAction(),
            requestNewChat: self.actions.requestNewChatAction(),
            prepareFork: self.actions.prepareForkAction(),
            hideSidebar: self.actions.hideSidebar)
            .padding(.top, drawerSafeAreaInsets.map { $0.top + 8 } ?? 0)
            .padding(.bottom, drawerSafeAreaInsets.map { $0.bottom + 8 } ?? 0)
            .safeAreaPadding(.top, drawerSafeAreaInsets == nil ? 8 : 0)
            .safeAreaPadding(.bottom, drawerSafeAreaInsets == nil ? 8 : 0)
            // Paints the wrapper's inset strips; RootSidebar's own background
            // stops at its bounds.
            .background(OpenClawSidebarPalette.background)
    }

    private var sidebarVerticalSeparator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(width: 1 / self.displayScale)
    }

    @ViewBuilder
    private var sidebarDetail: some View {
        switch self.presentation.selectedSidebarDestination.screen {
        case .chat:
            // Agent identity pill owns the chat header (prototype parity).
            ChatProTab(
                headerSidebarAction: self.sidebarHeaderAction,
                nativeBinding: self.presentation.nativeChatBinding,
                nativePresentationID: self.presentation.nativePresentationID,
                openSettings: self.actions.userDestinationAction(.gateway),
                prepareModal: self.actions.prepareChatModal,
                retainModalPresentation: self.actions.retainChatModalPresentation)
                .openClawChatModalPresentations(
                    self.presentation.chatModals,
                    origin: self.actions.currentChatModalScope?.origin ?? self.presentation.chatModals.standaloneOrigin,
                    actions: self.actions.chatModalActions)
        case .overview:
            CommandCenterTab(
                headerTitle: "Overview",
                headerSidebarAction: self.sidebarHeaderAction,
                dashboardModel: self.sidebarModel,
                openChat: self.actions.openChatAction(detail: true),
                prepareFork: self.actions.prepareForkAction(detail: true),
                openSettings: self.actions.userDestinationAction(.gateway),
                openSessions: self.actions.userDestinationAction(.sessions),
                openApprovals: self.actions.userAction(detail: true) { self.actions.selectSettingsRoute(.approvals) },
                openAutomations: self.actions.userDestinationAction(.cron),
                openUsage: self.actions.userDestinationAction(.usage))
        case let .dashboard(path):
            DashboardPageScreen(
                path: path,
                title: self.presentation.selectedSidebarDestination.title,
                navigationPath: self.actions.userSettingsPath,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: self.actions.handleSettingsRouteChange,
                onApprovalNotificationsRoute: self.actions.notificationSettingsAction(detail: true))
                .id(path)
        case .agents:
            AgentProTab(
                directRoute: .agents,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Agents",
                openSettings: self.actions.userDestinationAction(.gateway))
                .id(self.presentation.selectedSidebarDestination.id)
        case .sessions:
            CommandSessionsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openChat: self.actions.openChatAction(detail: true),
                prepareFork: self.actions.prepareForkAction(detail: true))
        case .files:
            AgentProTab(
                directRoute: .files,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Files",
                openSettings: self.actions.userDestinationAction(.gateway))
                .id(self.presentation.selectedSidebarDestination.id)
        case .desktop:
            DesktopHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: self.actions.userDestinationAction(.gateway))
        case .terminal:
            TerminalHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: self.actions.userDestinationAction(.gateway))
        case .docs:
            OpenClawDocsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: self.actions.userDestinationAction(.gateway))
        case .settings:
            SettingsHubScreen(
                navigationPath: self.actions.userSettingsPath,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: self.actions.handleSettingsRouteChange,
                onApprovalNotificationsRoute: self.actions.notificationSettingsAction(detail: true))
        case .gateway:
            SettingsProTab(
                directRoute: self.presentation.selectedSettingsRoute ?? self.presentation.selectedSidebarDestination
                    .settingsRoute ?? .gateway,
                acceptsGatewaySetupRequests: !self.presentation.showOnboarding,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: self.actions.handleSettingsRouteChange,
                onApprovalNotificationsRoute: self.actions.notificationSettingsAction(detail: true),
                gatewaySetupRequest: self.gatewaySetupRequest,
                onGatewaySetupRequestHandled: handleGatewaySetupRequest)
        }
    }

    private var sidebarDetailNavigationShell: some View {
        Group {
            if self.presentation.selectedSidebarDestination == .settings {
                self.sidebarDetailShell
            } else if case .dashboard = self.presentation.selectedSidebarDestination.screen {
                self.sidebarDetailShell
            } else {
                NavigationStack(path: self.actions.userSettingsPath) {
                    self.sidebarDetailShell
                }
            }
        }
        .onChange(of: self.presentation.sidebarNavigationPath) { _, navigationPath in
            self.actions.handleSidebarSettingsNavigationPathChange(navigationPath)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey? {
        if case .notificationSettings = self.presentation.presentedSheet {
            return self.presentation.suppressedExecApprovalForNotificationSettings
        }
        guard self.presentation.activeSettingsRoute == .approvals else { return nil }
        return NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)
    }

    private var sidebarHeaderAction: OpenClawSidebarHeaderAction? {
        guard Self.shouldShowSidebarRevealInDestinationHeader(
            isSidebarVisible: self.presentation.isSidebarVisible,
            layoutMode: self.presentation.isSidebarDrawerLayout ? .drawer : .split)
        else {
            return nil
        }
        if self.presentation.isSidebarVisible {
            return OpenClawSidebarHeaderAction(
                systemName: "line.3.horizontal",
                accessibilityLabel: .localized("Hide Sidebar"),
                accessibilityIdentifier: Self.sidebarHideButtonAccessibilityIdentifier,
                action: { self.actions.hideSidebar() })
        }
        return OpenClawSidebarHeaderAction(
            systemName: "line.3.horizontal",
            accessibilityLabel: .localized("Show Sidebar"),
            accessibilityIdentifier: Self.sidebarShowButtonAccessibilityIdentifier,
            action: { self.actions.showSidebar() })
    }

    private var sidebarAnimation: Animation? {
        self.reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.35, dampingFraction: 0.86)
    }

    private var sidebarTransition: AnyTransition {
        self.reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity)
    }

    private func shouldUseSidebarDrawer(containerSize: CGSize) -> Bool {
        Self.sidebarLayoutMode(containerSize: containerSize) == .drawer
    }

    private func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        Self.sidebarWidth(containerWidth: containerWidth, isDrawerLayout: isDrawerLayout)
    }

    private func foregroundKeyWindowSize() -> CGSize? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?
            .windows
            .first(where: \.isKeyWindow)?
            .bounds.size
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .top) {
                // Stable container so the toast's move/opacity transition animates
                // when the gateway problem appears or clears outside withAnimation.
                ZStack(alignment: .top) {
                    if let liveVoiceStartError = self.appModel.liveVoiceStartError {
                        // A banner survives onboarding dismissal without racing another modal.
                        OpenClawNoticeBanner(
                            icon: "mic.slash",
                            title: "Unable to Start Live Voice",
                            message: .verbatim(liveVoiceStartError),
                            ownerLabel: "Needs attention",
                            tint: OpenClawBrand.warn,
                            secondaryActionTitle: "Dismiss",
                            onSecondaryAction: { self.appModel.liveVoiceStartError = nil })
                            .padding(.horizontal, 12)
                            .safeAreaPadding(.top, 10)
                    } else if let gatewayRetryFailure {
                        OpenClawNoticeBanner(
                            icon: "wifi.exclamationmark",
                            title: "Gateway reconnect failed",
                            message: .verbatim(gatewayRetryFailure),
                            ownerLabel: "Needs attention",
                            tint: OpenClawBrand.warn,
                            secondaryActionTitle: "Dismiss",
                            onSecondaryAction: { self.gatewayRetryFailure = nil })
                            .padding(.horizontal, 12)
                            .safeAreaPadding(.top, 10)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    } else if let gatewayProblem = self.activeGatewayProblemToast {
                        self.gatewayProblemToast(gatewayProblem)
                    }
                }
                .animation(self.gatewayToastAnimation, value: self.gatewayRetryFailure)
                .animation(self.gatewayToastAnimation, value: self.activeGatewayProblemToast)
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(
                            .top,
                            self.activeGatewayProblemToast == nil && self.gatewayRetryFailure == nil
                                && self.appModel.liveVoiceStartError == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            .overlay {
                // Keep the observer mounted so the first 0 -> 1 capture transition
                // flashes without treating a later remount as a new capture.
                RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
            }
    }

    private var activeGatewayProblemToast: GatewayConnectionProblem? {
        // Operator-scope auth/pairing failures can coexist with a connected node.
        // The problem itself, not aggregate gateway status, owns toast visibility.
        guard let problem = appModel.lastGatewayProblem,
              !self.isGatewayToastSwipeDismissed
        else { return nil }
        return problem
    }

    private var gatewayToastAnimation: Animation? {
        self.reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)
    }

    private func gatewayProblemToast(_ problem: GatewayConnectionProblem) -> some View {
        let action = self.actions.navigationAction()
        return GatewayProblemBanner(
            problem: problem,
            primaryActionTitle: gatewayProblemPrimaryActionTitle(problem),
            onPrimaryAction: {
                self.handleGatewayProblemPrimaryAction(problem, onNavigate: action)
            },
            onShowDetails: {
                guard action() else { return }
                self.presentation.showGatewayProblemDetails = true
            })
            .padding(.horizontal, 12)
            .safeAreaPadding(.top, 10)
            .offset(y: min(self.gatewayToastDragOffset, 0))
            .gesture(self.gatewayToastSwipeGesture)
            // A drag cancelled by toast removal never fires onEnded; clear the
            // offset so the next toast doesn't render shifted up.
            .onDisappear { self.gatewayToastDragOffset = 0 }
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var gatewayToastSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                self.gatewayToastDragOffset = value.translation.height
            }
            .onEnded { value in
                let swipedUp = value.translation.height < -32 || value.predictedEndTranslation.height < -80
                withAnimation(self.gatewayToastAnimation) {
                    if swipedUp {
                        self.isGatewayToastSwipeDismissed = true
                    }
                    self.gatewayToastDragOffset = 0
                }
            }
    }

    private func handleGatewayProblemReport() {
        guard self.isGatewayToastSwipeDismissed else { return }
        self.isGatewayToastSwipeDismissed = false
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

                withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                    self.voiceWakeToastText = trimmed
                }

                self.toastDismissGate.schedule(after: .milliseconds(2300)) {
                    withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
    }

    private func rootAppearLifecycle(_ content: some View) -> some View {
        let inspections = self.actions.userModalBinding(self.$presentation.nativeRunInspection)
        return content
            .onAppear {
                self.updateIdleTimer()
                self.evaluateOnboardingPresentation(force: false)
                self.maybeAutoOpenSettings()
                self.maybeOpenSettingsForGatewaySetup()
                self.maybeShowQuickSetup()
                self.applyInitialChatSessionIfNeeded()
                self.handleLiveVoiceStartRequest()
                if self.appModel.consumeOpenChatRequest(self.appModel.openChatRequestID) {
                    self.actions.selectSidebarDestination(.chat)
                }
                if self.appModel.consumeDashboardNavigationRequest(self.appModel.dashboardNavigationRequestID) {
                    self.actions.selectSidebarDestination(.overview)
                }
                if self.nativeActions?
                    .capturePresentationAuthority(self.presentation.nativePresentationID) != nil { return }
                self.presentation.nativePresentationID = self.nativeActions?.registerPresentation(
                    onRetire: { disposition in
                        // Modal interactions and in-place session creation retire old
                        // native operations while retaining their current UI transport.
                        if case .departure = disposition { self.presentation.nativeChatBinding = nil }
                        self.presentation.nativeRunInspection = nil
                    },
                    onSessionAdopted: { previous, binding in
                        guard self.presentation.nativeChatBinding == nil ||
                            self.presentation.nativeChatBinding?.canReuse(previous) == true else { return }
                        self.presentation.nativeChatBinding = binding
                    },
                    { request, binding, receipt in
                        self.actions.synchronizeChatModalScope()
                        guard !self.presentation.chatModals.hasActivePresentation,
                              self.presentation.transcriptExportError == nil,
                              UIApplication.shared.applicationState == .active,
                              !self.presentation.showOnboarding, !self.presentation.showGatewayProblemDetails,
                              self.presentation.presentedSheet == nil,
                              self.presentation.pagesEditor == nil,
                              self.appModel.pendingExecApprovalPrompt == nil,
                              self.appModel.pendingNotificationPermissionGuidancePrompt == nil,
                              self.appModel.pendingAgentDeepLinkPrompt == nil,
                              self.gatewayController.pendingTrustPrompt == nil
                        else {
                            throw OpenClawNativeActionError("Finish the current screen in OpenClaw, then try again.")
                        }
                        if let existing = self.presentation.nativeRunInspection {
                            guard case let .inspect(run) = request, existing.inspection.run == run else {
                                throw OpenClawNativeActionError("Close the current run inspection, then try again.")
                            }
                        }
                        let session = request.session
                        self.appModel.setSelectedAgentId(session.agentID)
                        self.appModel.focusChatSession(session.sessionKey)
                        self.presentation.nativeChatBinding = binding
                        self.actions.selectSidebarDestination(.chat)
                        self.presentation.nativeRunInspection = receipt
                    })
                if let id = self.presentation.nativePresentationID {
                    #if DEBUG
                    let router = self.nativeActions
                    self.nativeLifetime.testLifetimeObservation = { [weak router] event in
                        router?.testLifetimeObservation?("root-\(event)")
                    }
                    #endif
                    self.nativeLifetime.own(id) {
                        #if DEBUG
                        self.nativeActions?.testLifetimeObservation?(
                            "root-cleanup current=\(self.nativeActions?.presentationRegistrationID == id)")
                        #endif
                        self.nativeActions?.unregisterPresentation(id)
                        guard self.presentation.nativePresentationID == id else { return }
                        self.presentation.nativePresentationID = nil
                        self.presentation.pagesEditor = nil
                        self.presentation.approvalDashboard.reset()
                        self.actions.clearChatModalScope()
                    }
                }
            }
            .sheet(item: inspections) { presentation in
                NavigationStack {
                    Form {
                        LabeledContent {
                            Text(presentation.inspection.run.runID).font(OpenClawType.body)
                        } label: {
                            Text("Run").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.sessionKey).font(OpenClawType.body)
                        } label: {
                            Text("Session").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.agentID).font(OpenClawType.body)
                        } label: {
                            Text("Agent").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.owner.profileID).font(OpenClawType.body)
                        } label: {
                            Text("Account").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.owner.gatewayID).font(OpenClawType.body)
                        } label: {
                            Text("Gateway").font(OpenClawType.body)
                        }
                        Text(presentation.inspection.summary)
                            .font(OpenClawType.body)
                            .textSelection(.enabled)
                    }
                    .navigationTitle("Run")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button {
                                // A replaced sheet may retain Done for its old receipt.
                                guard inspections.wrappedValue?.id == presentation.id else { return }
                                inspections.wrappedValue = nil
                            } label: {
                                Text("Done").font(OpenClawType.body)
                            }
                        }
                    }
                }
                .onAppear {
                    self.nativeActions?.acknowledgeInspection(
                        presentation,
                        presentationID: self.presentation.nativePresentationID)
                }
            }
            .onChange(of: self.appModel.chatSessionKey) { _, _ in self.clearChangedNativeChatSelection() }
            .onChange(of: self.appModel.chatDeliveryAgentId) { _, _ in self.clearChangedNativeChatSelection() }
            .onChange(of: self.appModel.chatTranscriptCacheGatewayID) { _, _ in
                self.clearChangedNativeChatSelection()
            }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                guard newValue == .active else {
                    self.clearVoiceWakeToast()
                    return
                }
                self.handleLiveVoiceStartRequest()
                self.maybeRequestLocalNetworkAccess(reason: "scene_active")
                Task {
                    await self.appModel.refreshGatewayOverviewIfConnected()
                }
            }
            .onDisappear { self.rootDidDisappear() }
    }

    private func rootDidDisappear() {
        #if DEBUG
        self.nativeActions?.testLifetimeObservation?("root-on-disappear")
        #endif
        if self.presentation.pagesEditor != nil {
            // Pages owns this cover, but never retains a native chat binding.
            // The exact-ID lifetime anchor still releases actual Root removal.
            _ = self.nativeActions?.userNavigationDidChange(
                presentationID: self.presentation.nativePresentationID,
                disposition: .departure)
        } else if self.actions.retainChatModalPresentation() {
            _ = self.nativeActions?.userNavigationDidChange(
                presentationID: self.presentation.nativePresentationID,
                disposition: .chatModal)
        } else {
            self.nativeLifetime.release()
            self.actions.clearChatModalScope()
        }
        UIApplication.shared.isIdleTimerDisabled = false
        self.clearVoiceWakeToast()
    }

    private func clearChangedNativeChatSelection() {
        guard let binding = self.presentation.nativeChatBinding else { return }
        let session = binding.session
        guard self.appModel.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8) == true,
              self.appModel.chatTranscriptCacheGatewayID?.utf8
                  .elementsEqual(session.owner.gatewayID.utf8) == true
        else {
            self.nativeActions?.retireChatSelection(presentationID: self.presentation.nativePresentationID)
            return
        }
    }

    private func clearVoiceWakeToast() {
        self.voiceWakeToastText = nil
        self.toastDismissGate.cancel()
    }

    private func rootGatewayProblemLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.appModel.lastGatewayProblem) { _, newValue in
                if newValue == nil {
                    self.isGatewayToastSwipeDismissed = false
                }
            }
            .onChange(of: self.appModel.gatewayProblemReportCount) { _, _ in
                self.handleGatewayProblemReport()
            }
    }

    private func rootGatewayLifecycle(_ content: some View) -> some View {
        self.rootGatewayProblemLifecycle(content)
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.onboardingComplete = true
                    self.hasConnectedOnce = true
                    OnboardingStateStore.markCompleted(mode: nil)
                }
                self.maybeAutoOpenSettings()
                self.maybeShowQuickSetup()
            }
    }

    private func rootRequestLifecycle(_ content: some View) -> some View {
        let isCurrent = self.actions.navigationContext()
        let action = self.actions.navigationAction()
        return content
            .onChange(of: self.onboardingRequestID) { _, _ in
                self.evaluateOnboardingPresentation(force: true)
            }
            .onChange(of: self.presentation.showOnboarding) { _, newValue in
                guard !newValue else { return }
                self.maybeRequestLocalNetworkAccess(reason: "onboarding_dismissed")
            }
            .onChange(of: self.appModel.pendingLiveVoiceStart) { _, _ in
                self.handleLiveVoiceStartRequest()
            }
            .onChange(of: self.appModel.openChatRequestID) { _, newValue in
                guard isCurrent(), self.appModel.consumeOpenChatRequest(newValue), action() else { return }
                self.actions.selectSidebarDestination(.chat)
            }
            .onChange(of: self.appModel.dashboardNavigationRequestID) { _, requestID in
                guard isCurrent(), self.appModel.consumeDashboardNavigationRequest(requestID), action() else { return }
                self.actions.selectSidebarDestination(.overview)
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                guard isCurrent() else { return }
                self.maybeOpenSettingsForGatewaySetup(onAccepted: action)
            }
            .onChange(of: NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)) { _, newValue in
                if newValue != self.presentation.suppressedExecApprovalForNotificationSettings {
                    self.presentation.suppressedExecApprovalForNotificationSettings = nil
                }
            }
    }

    private func rootPresentation(_ content: some View) -> some View {
        let action = self.actions.navigationAction()
        let sheets = self.actions.chatSheetBinding
        return content
            .sheet(isPresented: self.actions.userModalBinding(self.$presentation.showGatewayProblemDetails)) {
                if let gatewayProblem = self.appModel.lastGatewayProblem {
                    GatewayProblemDetailsSheet(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem, onNavigate: action)
                        })
                }
            }
            .sheet(item: sheets) { sheet in
                let sheetAction: @MainActor @Sendable () -> Bool = {
                    guard self.presentation.presentedSheet == sheet else { return false }
                    if let receipt = sheet.chatReceipt {
                        return receipt.retireIfCurrent()
                    }
                    return action()
                }
                Group {
                    switch sheet {
                    case .quickSetup:
                        GatewayQuickSetupSheet(onUseManualSetup: {
                            guard sheetAction() else { return }
                            self.presentation.presentedSheet = nil
                            self.actions.selectSettingsRoute(.gateway)
                        })
                        .environment(self.appModel)
                        .environment(self.gatewayController)
                        .openClawSheetChrome()
                    case let .notificationSettings(path):
                        DashboardPageScreen(
                            path: path,
                            title: String(localized: "Notifications"),
                            onClose: { sheets.wrappedValue = nil })
                    case let .sessionDashboard(sessionKey, agentId):
                        NavigationStack {
                            SessionDashboardScreen(sessionKey: sessionKey, agentId: agentId)
                        }
                    case let .backgroundTasks(agentID, receipt):
                        self.chatModalContent(receipt) { BackgroundTasksScreen(agentID: agentID) }
                    case let .newSessionOptions(viewModel, receipt):
                        self.chatModalContent(receipt) {
                            ChatNewSessionOptionsPopover(viewModel: viewModel) {
                                self.actions.dismissChatModal(receipt)
                            }
                            .presentationDetents([.medium])
                            .presentationDragIndicator(.visible)
                        }
                    case let .transcriptShare(fileURL, receipt):
                        self.chatModalContent(receipt) { OpenClawChatFileShareSheet(fileURL: fileURL) }
                    }
                }
                .environment(\.userNavigationAction, sheetAction)
            }
            .alert(
                String(localized: "Unable to Export Transcript"),
                isPresented: self.actions.transcriptExportErrorBinding)
            {
                let receipt = self.presentation.transcriptExportError
                Button(role: .cancel) {
                    if let receipt { self.actions.dismissChatModal(receipt) }
                } label: {
                    Text("OK").font(OpenClawType.body)
                }
            } message: {
                Text("OpenClaw could not prepare the Markdown file.").font(OpenClawType.body)
            }
            .fullScreenCover(isPresented: self.$presentation.showOnboarding) {
                    OnboardingWizardView(
                        allowSkip: self.onboardingAllowSkip,
                        onRequestLocalNetworkAccess: { reason in
                            self.requestLocalNetworkAccess(reason: reason)
                        },
                        onClose: {
                            self.presentation.showOnboarding = false
                        },
                        onComplete: {
                            self.presentation.showOnboarding = false
                            self.actions.selectSidebarDestination(.chat)
                        })
                        .environment(self.appModel)
                        .environment(self.voiceWake)
                        .environment(self.gatewayController)
                }
                .gatewayTrustPromptAlert(isEnabled: !self.presentation.showOnboarding)
                .deepLinkAgentPromptAlert()
                .execApprovalPromptDialog(
                    suppressedApproval: self.activeExecApprovalPromptSuppression,
                    dashboardPresentation: self.presentation.approvalDashboard)
                .notificationPermissionGuidanceDialog(openNotifications: self.actions.notificationSettingsAction())
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }
}

extension RootTabs {
    /// Shared sheets carry this frozen root context through async publication and
    /// dismissal. A retained callback can never borrow a replacement registration.
    static func makeChatModalActions(
        origin: OpenClawChatModalOrigin?,
        router: NativeActionRouter?,
        rootID: UUID?,
        isCurrentScope: @escaping @MainActor () -> Bool,
        isCurrentContainer: @escaping @MainActor () -> Bool) -> OpenClawChatModalActions
    {
        let isCurrent: @MainActor (OpenClawChatModalOrigin) -> Bool = {
            origin == $0 && isCurrentScope() &&
                (router == nil || router?.capturePresentationAuthority(rootID) != nil)
        }
        return OpenClawChatModalActions(
            capture: { requested in
                guard isCurrent(requested), isCurrentContainer() else { return nil }
                let authority = router?.capturePresentationAuthority(rootID)
                let permitIsCurrent: @MainActor () -> Bool = {
                    isCurrent(requested) && isCurrentContainer() &&
                        (router == nil || authority.map { router?.isCurrentPresentation($0) == true } == true)
                }
                return .init(isCurrent: permitIsCurrent, accept: {
                    guard permitIsCurrent() else { return false }
                    return router?.userNavigationDidChange(
                        presentationID: rootID,
                        disposition: .chatModal) ?? true
                })
            },
            dismiss: { requested in
                guard isCurrent(requested) else { return }
                _ = router?.userNavigationDidChange(presentationID: rootID, disposition: .chatModal)
            },
            isCurrent: isCurrent)
    }

    private func chatModalContent(
        _ receipt: OpenClawChatModalPresentations.Receipt,
        @ViewBuilder content: () -> some View) -> some View
    {
        content().openClawChatModalPresentations(
            self.presentation.chatModals,
            origin: receipt.origin,
            actions: self.actions.chatModalActions,
            parent: receipt,
            parentIsCurrent: { self.presentation.presentedSheet?.chatReceipt?.id == receipt.id })
    }

    static func matchedModalBinding<Value: Equatable>(
        _ binding: Binding<Value>,
        admit: @escaping @MainActor () -> Bool) -> Binding<Value>
    {
        let expected = binding.wrappedValue
        return Binding(get: { binding.wrappedValue }, set: { value in
            guard value != binding.wrappedValue, binding.wrappedValue == expected, admit() else { return }
            binding.wrappedValue = value
        })
    }

    private func handleLiveVoiceStartRequest() {
        guard self.didApplyInitialChatSession, self.didEvaluateOnboarding,
              self.scenePhase == .active, self.appModel.pendingLiveVoiceStart
        else { return }
        if !self.presentation.showOnboarding {
            self.presentation.presentedSheet = nil
            self.presentation.showGatewayProblemDetails = false
        }
        self.appModel.consumeLiveVoiceStartRequest(
            isSceneActive: true,
            isOnboardingPresented: self.presentation.showOnboarding,
            hasGatewayConfiguration: self.hasExistingGatewayConfig() || self.appModel.gatewayServerName != nil)
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String? {
        GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry",
            resetTitle: "Reset onboarding",
            nonRetryableTitle: "Open Settings")
    }

    private func handleGatewayProblemPrimaryAction(
        _ problem: GatewayConnectionProblem,
        onNavigate: () -> Bool)
    {
        if problem.suggestsOnboardingReset {
            // Reset bumps onboarding.requestID, which re-presents the wizard.
            let instanceId = UserDefaults.standard.string(forKey: "node.instanceId") ?? ""
            Task {
                await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: instanceId)
            }
        } else if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem) {
            return
        } else if problem.retryable {
            self.gatewayRetryFailure = nil
            Task {
                if case let .failed(message) = await self.gatewayController.retryGatewayConnection() {
                    self.gatewayRetryFailure = message
                }
            }
        } else {
            guard onNavigate() else { return }
            self.actions.selectSidebarDestination(.gateway)
        }
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.presentation.showOnboarding = true
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
            self.presentation.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.actions.selectSidebarDestination(.gateway)
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.activeGatewayEntry() != nil { return true }

        let preferredStableID = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferredStableID.isEmpty { return true }

        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func maybeAutoOpenSettings() {
        guard !self.didAutoOpenSettings else { return }
        guard !self.presentation.showOnboarding else { return }
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoOpenSettings = true
        self.actions.selectSidebarDestination(.gateway)
        self.maybeRequestLocalNetworkAccess(reason: "auto_open_settings")
    }

    private func maybeOpenSettingsForGatewaySetup(onAccepted: () -> Bool = { true }) {
        let requestID = self.appModel.gatewaySetupRequestID
        guard requestID != 0, requestID != self.gatewaySetupRequest?.id else { return }
        // The presented onboarding flow owns setup-link staging until it dismisses.
        guard !self.presentation.showOnboarding else { return }
        guard let link = appModel.consumePendingGatewaySetupLink(), onAccepted() else { return }
        self.presentation.showOnboarding = false
        self.presentation.presentedSheet = nil
        self.didAutoOpenSettings = true
        self.actions.selectSidebarDestination(.gateway)
        // Root owns delivery so embedded Settings views cannot consume the one-shot link.
        self.gatewaySetupRequest = GatewaySetupRequest(id: requestID, link: link)
        self.requestLocalNetworkAccess(reason: "gateway_setup_deeplink")
    }

    private func handleGatewaySetupRequest(_ requestID: Int) {
        guard self.gatewaySetupRequest?.id == requestID else { return }
        self.gatewaySetupRequest = nil
    }

    private func maybeRequestLocalNetworkAccess(reason: String) {
        guard self.didEvaluateOnboarding else { return }
        guard self.scenePhase == .active else { return }
        guard !self.presentation.showOnboarding else { return }
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

    private func maybeShowQuickSetup() {
        let shouldPresent = Self.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.presentation.showOnboarding,
            hasPresentedSheet: self.presentation.presentedSheet != nil,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.presentation.presentedSheet = .quickSetup
    }
}

private struct RootCameraFlashOverlay: View {
    @Environment(\.scenePhase) private var scenePhase

    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var dismissGate = DelayedActionGate()

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                guard self.scenePhase == .active else {
                    self.clearFlash()
                    return
                }
                self.showFlash()
            }
            .onChange(of: self.scenePhase) { _, newValue in
                guard newValue != .active else { return }
                self.clearFlash()
            }
            .onDisappear { self.clearFlash() }
    }

    private func showFlash() {
        withAnimation(.easeOut(duration: 0.08)) {
            self.opacity = 0.85
        }
        self.dismissGate.schedule(after: .milliseconds(110)) {
            withAnimation(.easeOut(duration: 0.32)) {
                self.opacity = 0
            }
        }
    }

    private func clearFlash() {
        self.opacity = 0
        self.dismissGate.cancel()
    }
}
