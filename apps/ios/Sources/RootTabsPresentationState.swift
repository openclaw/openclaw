import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// The navigation and modal owner is shared by the hosted Root and its actions.
/// It does not own the view lifetime anchor or retain registration cleanup.
@MainActor
@Observable
final class RootTabsPresentationState {
    typealias SidebarDestination = RootTabs.SidebarDestination
    typealias PresentedSheet = RootTabs.PresentedSheet
    typealias SidebarPagesPresentation = RootTabs.SidebarPagesPresentation

    var selectedSidebarDestination: SidebarDestination = .chat
    var selectedSettingsRoute: SettingsRoute?
    var activeSettingsRoute: SettingsRoute?
    var selectedSettingsRouteRequestID: Int = 0
    // Embedded Settings rows push onto the sidebar stack; clear it before
    // changing sidebar roots so stale settings detail screens cannot survive.
    var sidebarNavigationPath: [SettingsRoute] = []
    var isSidebarDetailRootVisible: Bool = true
    var isSidebarVisible: Bool = false
    var sidebarVisibilityUserOverridden: Bool = false
    var isSidebarDrawerLayout: Bool = false
    var didResolveSidebarLayout: Bool = false
    var presentedSheet: PresentedSheet?
    var pagesEditor: SidebarPagesPresentation?
    var showGatewayProblemDetails: Bool = false
    var showOnboarding: Bool = false
    var suppressedExecApprovalForNotificationSettings: NodeAppModel.ExecApprovalInboxKey?
    let approvalDashboard = ApprovalDashboardPresentationState()
    var nativeRunInspection: NativeActionRouter.RunPresentation?
    var nativeChatBinding: IOSNativeActionBinding?
    var nativePresentationID: UUID?
    var chatModals = OpenClawChatModalPresentations()
    var chatModalScope: ChatModalScope?
    var transcriptExportError: OpenClawChatModalPresentations.Receipt?

    struct ChatModalScope: Equatable {
        let origin: OpenClawChatModalOrigin
        let shellID: String
        let ownerID: String
        let sessionKey: String
        let agentID: String?
        let accountGeneration: UInt64
        let inputs: GatewayConnectConfig.ControlUIInputs?
    }

    init(initialDestination: SidebarDestination = .chat, initialSidebarVisibility: Bool? = nil) {
        self.selectedSidebarDestination = initialDestination
        self.selectedSettingsRoute = initialDestination.settingsRoute
        self.activeSettingsRoute = initialDestination.settingsRoute
        self.isSidebarVisible = initialSidebarVisibility ?? false
        self.sidebarVisibilityUserOverridden = initialSidebarVisibility != nil
    }

    var sidebarDetailShellID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "root"
        return "\(self.selectedSidebarDestination.id):\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    var shouldCollapseSidebarAfterSelection: Bool {
        RootTabs.shouldCollapseSidebarAfterSelection(
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
    }

    /// Value actions capture the real owner and services without retaining a Root view.
    @MainActor
    struct Actions {
        let state: RootTabsPresentationState
        let appModel: NodeAppModel
        let nativeActions: NativeActionRouter?
        let gatewayController: GatewayConnectionController
        let sidebarAnimation: Animation?

        func binding<Value>(_ keyPath: ReferenceWritableKeyPath<RootTabsPresentationState, Value>) -> Binding<Value> {
            Bindable(self.state)[dynamicMember: keyPath]
        }

        var currentChatModalScope: ChatModalScope? {
            guard self.state.selectedSidebarDestination == .chat,
                  let viewModel = self.appModel.chatPresentation.viewModel else { return nil }
            return ChatModalScope(
                origin: .init(viewModel: viewModel),
                shellID: self.state.sidebarDetailShellID,
                ownerID: self.appModel.chatViewModelOwnerID,
                sessionKey: self.appModel.chatSessionKey,
                agentID: self.appModel.chatDeliveryAgentId,
                accountGeneration: self.appModel.operatorAuthorityGeneration,
                inputs: self.appModel.activeGatewayConnectConfig?.controlUIInputs)
        }

        func clearChatModalScope() {
            if let scope = self.state.chatModalScope { self.state.chatModals.invalidate(origin: scope.origin) }
            if self.state.presentedSheet?.chatReceipt != nil { self.state.presentedSheet = nil }
            self.state.transcriptExportError = nil
            self.state.chatModalScope = nil
        }

        func synchronizeChatModalScope() {
            let current = self.currentChatModalScope
            guard self.state.chatModalScope != current else { return }
            self.clearChatModalScope()
            self.state.chatModalScope = current
            if let current { self.state.chatModals.synchronize(origin: current.origin) }
        }

        var chatModalActions: OpenClawChatModalActions {
            let scope = self.currentChatModalScope
            let contextIsCurrent = self.navigationContext(detail: true)
            let container = self.state.presentedSheet
            let inspection = self.state.nativeRunInspection
            return RootTabs.makeChatModalActions(
                origin: scope?.origin,
                router: self.nativeActions,
                rootID: self.state.nativePresentationID,
                isCurrentScope: { scope == self.currentChatModalScope && contextIsCurrent() },
                isCurrentContainer: {
                    self.state.presentedSheet == container && self.state.nativeRunInspection == inspection &&
                        self.state.transcriptExportError == nil && !self.state.showOnboarding &&
                        !self.state.showGatewayProblemDetails && self.appModel.pendingExecApprovalPrompt == nil &&
                        self.appModel.pendingNotificationPermissionGuidancePrompt == nil &&
                        self.appModel.pendingAgentDeepLinkPrompt == nil &&
                        self.gatewayController.pendingTrustPrompt == nil
                })
        }

        func retainChatModalPresentation() -> Bool {
            // Reset actual target/account departure before treating disappearance as cover.
            self.synchronizeChatModalScope()
            guard let scope = self.state.chatModalScope else { return false }
            return self.state.chatModals.hasActivePresentation(for: scope.origin) ||
                self.state.presentedSheet?.chatReceipt?.origin == scope.origin ||
                self.state.transcriptExportError?.origin == scope.origin
        }

        func prepareChatModal(_ viewModel: OpenClawChatViewModel) -> IOSChatModalPublication? {
            self.synchronizeChatModalScope()
            guard self.appModel.chatPresentation.viewModel === viewModel,
                  let scope = self.state.chatModalScope, self.state.presentedSheet == nil,
                  self.state.transcriptExportError == nil, !self.state.chatModals.hasActivePresentation,
                  let capture = self.state.chatModals.capture(
                      origin: scope.origin,
                      producerID: UUID(),
                      actions: self.chatModalActions)
            else { return nil }
            return IOSChatModalPublication(
                isCurrent: { capture.isCurrent },
                present: { request in
                    guard self.state.presentedSheet == nil, self.state.transcriptExportError == nil,
                          capture.accept() else { return }
                    let receipt = capture.receipt
                    switch request {
                    case let .backgroundTasks(agentID):
                        self.state.presentedSheet = .backgroundTasks(agentID: agentID, receipt: receipt)
                    case let .newSessionOptions(viewModel):
                        self.state.presentedSheet = .newSessionOptions(viewModel, receipt: receipt)
                    case let .transcriptShare(fileURL):
                        self.state.presentedSheet = .transcriptShare(fileURL, receipt: receipt)
                    case .transcriptExportError:
                        self.state.transcriptExportError = receipt
                    }
                })
        }

        func dismissChatModal(_ receipt: OpenClawChatModalPresentations.Receipt) {
            guard self.state.presentedSheet?.chatReceipt?.id == receipt.id ||
                self.state.transcriptExportError?.id == receipt.id else { return }
            receipt.retireIfCurrent()
            self.state.chatModals.removeDescendants(of: receipt)
            if self.state.presentedSheet?.chatReceipt?.id == receipt.id { self.state.presentedSheet = nil }
            if self.state.transcriptExportError?.id == receipt.id { self.state.transcriptExportError = nil }
        }

        var chatSheetBinding: Binding<PresentedSheet?> {
            let expected = self.state.presentedSheet
            let ordinary = self.userModalBinding(self.binding(\.presentedSheet))
            return Binding(get: { self.state.presentedSheet }, set: { value in
                guard self.state.presentedSheet == expected else { return }
                if let receipt = expected?.chatReceipt, value == nil {
                    self.dismissChatModal(receipt)
                } else {
                    ordinary.wrappedValue = value
                }
            })
        }

        var transcriptExportErrorBinding: Binding<Bool> {
            let receipt = self.state.transcriptExportError
            return Binding(get: { self.state.transcriptExportError != nil }, set: { value in
                if !value, let receipt { self.dismissChatModal(receipt) }
            })
        }

        /// Freeze the root and (for detail callbacks) stack that produced this action.
        /// A callback retained by a departed view cannot act for a replacement root.
        func navigationContext(detail: Bool = false) -> @MainActor @Sendable () -> Bool {
            let router = self.nativeActions
            let rootID = self.state.nativePresentationID
            let shellID = detail ? self.state.sidebarDetailShellID : nil
            return {
                (router == nil || router?.capturePresentationAuthority(rootID) != nil) &&
                    (shellID == nil || shellID == self.state.sidebarDetailShellID)
            }
        }

        func navigationAction(
            detail: Bool = false,
            disposition: NativeActionRouter.RetirementDisposition = .departure)
            -> @MainActor @Sendable () -> Bool
        {
            let isCurrent = self.navigationContext(detail: detail)
            let router = self.nativeActions
            let rootID = self.state.nativePresentationID
            return {
                guard isCurrent() else { return false }
                return router?.userNavigationDidChange(presentationID: rootID, disposition: disposition) ?? true
            }
        }

        func userAction(
            detail: Bool = false,
            disposition: NativeActionRouter.RetirementDisposition = .departure,
            _ perform: @escaping @MainActor () -> Void) -> @MainActor () -> Void
        {
            let action = self.navigationAction(detail: detail, disposition: disposition)
            return {
                guard action() else { return }
                perform()
            }
        }

        func requestNewChatAction() -> @MainActor () -> Void {
            self.userAction(disposition: .chatSessionTransition) {
                self.appModel.chatPresentation.requestNewChat(
                    appModel: self.appModel,
                    presentation: .init(
                        binding: self.state.nativeChatBinding,
                        router: self.nativeActions,
                        id: self.state.nativePresentationID))
                self.selectSidebarDestination(.chat)
            }
        }

        func userDestinationAction(_ destination: SidebarDestination) -> @MainActor () -> Void {
            self.userAction(detail: true) { self.selectSidebarDestination(destination) }
        }

        var userSettingsPath: Binding<[SettingsRoute]> {
            let action = self.navigationAction(detail: true)
            return Binding(get: { self.state.sidebarNavigationPath }, set: { path in
                guard path != self.state.sidebarNavigationPath, action() else { return }
                self.state.sidebarNavigationPath = path
            })
        }

        func userModalBinding<Value: Equatable>(_ binding: Binding<Value>) -> Binding<Value> {
            RootTabs.matchedModalBinding(binding, admit: self.navigationAction())
        }

        func notificationSettingsAction(detail: Bool = false) -> (String?) -> Void {
            let action = self.navigationAction(detail: detail)
            return { approvalID in
                guard action() else { return }
                self.openNotificationSettings(approvalID)
            }
        }

        func chatTarget(_ session: OpenClawChatSessionEntry) -> OpenClawChatSessionTarget {
            IOSGatewayChatTransport.sessionTarget(
                for: session.key,
                selectedAgentID: self.appModel.chatDeliveryAgentId,
                overrideAgentID: session.agentId)
        }

        func commitChatNavigation(_ target: OpenClawChatSessionTarget) {
            self.appModel.focusChatSession(target)
            self.appModel.openChat(sessionKey: target.sessionKey)
            // UI navigation is already admitted. Its request projection must not retire
            // a newer native action when SwiftUI delivers the later onChange callback.
            _ = self.appModel.consumeOpenChatRequest(self.appModel.openChatRequestID)
            self.selectSidebarDestination(.chat)
        }

        func openChatAction(detail: Bool = false) -> (OpenClawChatSessionTarget) -> Void {
            let action = self.navigationAction(detail: detail)
            return { target in
                guard action() else { return }
                self.commitChatNavigation(target)
            }
        }

        func prepareForkAction(detail: Bool = false) -> (OpenClawChatSessionEntry) -> PreparedChatNavigation? {
            let action = self.navigationAction(detail: detail)
            let context = self.navigationContext(detail: detail)
            let router = self.nativeActions
            let rootID = self.state.nativePresentationID
            return { session in
                guard action() else { return nil }
                return PreparedChatNavigation.capture(
                    appModel: self.appModel,
                    router: router,
                    presentationID: rootID,
                    session: session,
                    isCurrentContext: context,
                    currentNativeBinding: { self.state.nativeChatBinding },
                    open: { self.commitChatNavigation($0) })
            }
        }

        func selectSidebarSession(_ session: OpenClawChatSessionEntry) {
            switch RootTabs.sidebarPresentation(for: session) {
            case .chat:
                self.commitChatNavigation(self.chatTarget(session))
            case .dashboard:
                let target = RootTabs.sidebarDashboardTarget(for: session)
                self.state.presentedSheet = .sessionDashboard(
                    sessionKey: target.sessionKey,
                    agentId: target.agentId)
                guard self.state.shouldCollapseSidebarAfterSelection else { return }
                withAnimation(self.sidebarAnimation) {
                    self.setSidebarVisible(false)
                }
            }
        }

        func selectSidebarDestination(_ destination: SidebarDestination) {
            // Replace stale stack callbacks without remounting an unchanged native Chat.
            if self.state.selectedSidebarDestination != destination || !self.state.sidebarNavigationPath.isEmpty {
                self.state.selectedSettingsRouteRequestID &+= 1
            }
            self.state.sidebarNavigationPath.removeAll()
            self.state.suppressedExecApprovalForNotificationSettings = nil
            self.state.selectedSidebarDestination = destination
            self.state.selectedSettingsRoute = destination.settingsRoute
            self.state.activeSettingsRoute = destination.settingsRoute
            guard self.state.shouldCollapseSidebarAfterSelection else { return }
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(false)
            }
        }

        func selectSettingsRoute(_ route: SettingsRoute) {
            self.state.sidebarNavigationPath.removeAll()
            self.state.suppressedExecApprovalForNotificationSettings = nil
            self.state.selectedSettingsRoute = nil
            self.state.activeSettingsRoute = route
            self.state.selectedSettingsRouteRequestID &+= 1
            self.state.selectedSidebarDestination = .settings
            self.state.sidebarNavigationPath = [route]
            guard self.state.shouldCollapseSidebarAfterSelection else { return }
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(false)
            }
        }

        func openNotificationSettings(_ approvalID: String?) {
            if let approvalID {
                self.suppressExecApprovalPromptForNotificationSettings(approvalID)
            }
            let path = RootTabs.notificationSettingsPath(
                servingEnabled: NotificationServingPreference.isEnabled(),
                disclosureAccepted: !PushBuildConfig.current.usesOpenClawHostedRelay
                    || PushEnrollmentConsent.disclosureAccepted)
            self.state.presentedSheet = .notificationSettings(path: path)
        }

        func suppressExecApprovalPromptForNotificationSettings(_ approvalID: String) {
            guard let approvalID = ExecApprovalIdentifier.key(approvalID),
                  let prompt = self.appModel.pendingExecApprovalPrompt,
                  ExecApprovalIdentifier.key(prompt.id) == approvalID
            else { return }
            self.state.suppressedExecApprovalForNotificationSettings = NodeAppModel.execApprovalInboxKey(prompt)
        }

        func handleSettingsRouteChange(_ route: SettingsRoute?) {
            self.state.activeSettingsRoute = route
            if route == nil {
                self.state.selectedSettingsRoute = nil
                if self.state.selectedSidebarDestination == .settings {
                    self.state.selectedSidebarDestination = .settings
                }
            }
            self.state.suppressedExecApprovalForNotificationSettings = nil
        }

        func handleSidebarSettingsNavigationPathChange(_ navigationPath: [SettingsRoute]) {
            guard self.state.selectedSidebarDestination == .settings || self.state
                .selectedSidebarDestination == .gateway
            else {
                return
            }
            let baseRoute = self.state.selectedSettingsRoute ?? self.state.selectedSidebarDestination.settingsRoute
            let route = RootTabs.visibleSettingsRoute(
                navigationPath: navigationPath,
                baseRoute: baseRoute)
            self.handleSettingsRouteChange(route)
        }

        func showSidebar() {
            self.state.sidebarVisibilityUserOverridden = true
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(true)
            }
        }

        func hideSidebar() {
            self.state.sidebarVisibilityUserOverridden = true
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(false)
            }
        }

        func updateSidebarLayout(containerSize: CGSize, force: Bool) {
            let layoutMode = RootTabs.sidebarLayoutMode(containerSize: containerSize)
            let previousLayoutMode: RootTabs.SidebarLayoutMode = self.state.isSidebarDrawerLayout ? .drawer : .split
            let didResolvePreviousLayout = self.state.didResolveSidebarLayout
            let layoutModeDidChange = layoutMode != previousLayoutMode
            self.state.didResolveSidebarLayout = true
            self.state.isSidebarDrawerLayout = layoutMode == .drawer
            if layoutModeDidChange && didResolvePreviousLayout {
                self.state.sidebarVisibilityUserOverridden = false
            }
            guard force || !self.state.sidebarVisibilityUserOverridden else { return }

            let preferredVisibility = RootTabs.preferredSidebarVisibility(layoutMode: layoutMode)
            guard self.state.isSidebarVisible != preferredVisibility else { return }
            self.setSidebarVisible(preferredVisibility)
        }

        func setSidebarVisible(_ isVisible: Bool) {
            self.state.isSidebarVisible = isVisible
        }
    }
}
