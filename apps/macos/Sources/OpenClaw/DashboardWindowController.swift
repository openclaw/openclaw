import AppKit
import AVFoundation
import Foundation
import OpenClawKit
import WebKit

private final class DashboardWindowContentView: NSView {
    override var mouseDownCanMoveWindow: Bool {
        true
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Command-translated characters preserve the shortcut on alternate layouts.
        guard event.type == .keyDown,
              event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command,
              event.characters?.lowercased() == "w",
              let window, window.attachedSheet == nil,
              let controller = window.windowController as? DashboardWindowController
        else { return super.performKeyEquivalent(with: event) }
        // Claim the key before AppKit's Close Window menu action. The web owner
        // decides whether a focused side tab exists; the traffic light is unchanged.
        controller.closeFocusedPanelOrWindow()
        return true
    }
}

/// The dashboard's empty unified toolbar exists only to grow the titlebar to
/// 52pt so the traffic lights align with the hosted web chrome. `View > Hide
/// Toolbar` (and ⌥⌘T) would collapse the titlebar while the web inset stays
/// pinned at `--openclaw-native-titlebar-height`, resurrecting the traffic-light
/// misalignment. Refusing the toggle keeps the two heights in lockstep.
/// Full screen hides this sizing toolbar so it cannot cover the web controls.
private final class DashboardWindow: ExperienceWindow {
    /// User intent belongs to the native window, not the privileged document it hosts.
    var userIntentGeneration: UInt64 = 0
    var lifetimeRevision: UInt64 = 0
    var pendingGatewaySwitch: DashboardGatewaySwitchIntent?

    override func toggleToolbarShown(_: Any?) {}

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(NSWindow.toggleToolbarShown(_:)) {
            return false
        }
        return super.validateUserInterfaceItem(item)
    }
}

final class DashboardGatewaySwitchIntent {
    let target: DashboardGatewayTarget

    init(target: DashboardGatewayTarget) {
        self.target = target
    }
}

@MainActor
private final class DashboardMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveMessage(message)
    }
}

@MainActor
final class DashboardWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private static let linkMessageHandlerName = "openclawLink"
    private static let windowDragMessageHandlerName = "openclawWindowDrag"
    private static let updateMessageHandlerName = "openclawUpdate"
    private static let commandsMessageHandlerName = "openclawCommands"

    let webView: DashboardWebView
    let nativeBrowser: DashboardNativeBrowserHost
    private let messageHandler: DashboardMessageHandler
    let deviceSettingsMessageHandler: DashboardDeviceSettingsMessageHandler
    private(set) var currentURL: URL
    var auth: DashboardWindowAuth
    var gatewaySnapshot: DashboardGatewaySnapshot?
    var notificationPermission = "notDetermined"
    var notificationTestOutcome: TestNotificationOutcome?
    private(set) var notificationSourceID = UUID().uuidString
    var onBackgroundSessionOpen: ((DashboardBackgroundSessionCompletion, URL) -> Void)?
    let tlsParams: GatewayTLSParams?
    private let browserSessionLease: DashboardBrowserSessionStore.Lease?
    var browserSession: GatewayBrowserSession? {
        self.browserSessionLease?.session
    }

    var hasCurrentBrowserSession: Bool {
        // Renewals revoke the lease before awaited WebKit cleanup replaces the document.
        guard self.browserSessionLease?.isCurrent != false else { return false }
        do {
            try self.browserSession?.validate(for: self.currentURL)
            return true
        } catch {
            return false
        }
    }

    private let dashboardFrameAutosaveName: String
    let updater: UpdaterProviding?
    private var updateBridgeEnabled: Bool
    private let requestBrowserProfileImportOffer:
        @MainActor (@escaping @MainActor () -> Bool) async -> Bool
    private var canGoBackObservation: NSKeyValueObservation?
    private var canGoForwardObservation: NSKeyValueObservation?
    private var didRequestBrowserProfileImportOffer = false
    private var browserProfileImportOfferIsArmed = false
    private var browserProfileImportOfferRequestIsInFlight = false
    private var browserProfileImportOfferRetryPending = false
    private var hasLiveContent = false
    private var nativeCommandsReady = false
    private(set) var gatewayHealth: DashboardGatewayHealth?
    private var gatewayHealthReadRevision: UInt64 = 0
    var onGatewayHealthChanged: (() -> Void)?
    private(set) var isShowingFailurePage = false
    private(set) var signedOut: DashboardFailurePage.SignedOut?
    private(set) var signedOutNeedsRefresh = false
    private var reconnectTask: (id: UUID, task: Task<Void, Never>)?
    private var signInProgress: GatewayBrowserSignInProgress?
    private var browserSignInRoute: (baseURL: URL, url: URL)?
    private var navigationGeneration: UInt64 = 0
    private var loadGeneration: UInt64 = 0
    private var pendingLoad: Task<Void, Never>?
    private var pendingNativeCommands: [DashboardNativeCommand] = []
    private var pendingNativeNavigation: DashboardNativeNavigation?
    var onClosed: (() -> Void)?

    init(
        url: URL,
        auth: DashboardWindowAuth,
        websiteDataStore: WKWebsiteDataStore,
        updater: UpdaterProviding? = nil,
        updateBridgeEnabled: Bool = true,
        tlsParams: GatewayTLSParams? = nil,
        browserSessionLease: DashboardBrowserSessionStore.Lease? = nil,
        gatewaySnapshot: DashboardGatewaySnapshot? = nil,
        windowTitle: String = "OpenClaw",
        windowAutosaveName: String,
        reusingWindow: NSWindow? = nil,
        requestBrowserProfileImportOffer:
        @escaping @MainActor (@escaping @MainActor () -> Bool) async -> Bool)
    {
        let shouldEnableUpdateBridge = updater?.isAvailable == true && updateBridgeEnabled
        self.currentURL = url
        self.auth = auth
        self.gatewaySnapshot = gatewaySnapshot
        self.tlsParams = tlsParams
        self.browserSessionLease = browserSessionLease
        self.dashboardFrameAutosaveName = windowAutosaveName
        self.updater = updater
        self.updateBridgeEnabled = shouldEnableUpdateBridge
        self.requestBrowserProfileImportOffer = requestBrowserProfileImportOffer

        let config = WKWebViewConfiguration()
        config.websiteDataStore = websiteDataStore
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.tabFocusesLinks = true
        config.userContentController = WKUserContentController()
        let messageHandler = DashboardMessageHandler()
        self.messageHandler = messageHandler
        for name in [
            Self.linkMessageHandlerName,
            Self.windowDragMessageHandlerName,
            Self.notificationsMessageHandlerName,
            Self.gatewaysMessageHandlerName,
            Self.commandsMessageHandlerName,
        ] {
            config.userContentController.add(messageHandler, name: name)
        }
        let appLinkMessageHandler = DashboardAppLinkMessageHandler()
        config.userContentController.add(
            appLinkMessageHandler,
            contentWorld: DashboardAppLinkMessageHandler.world,
            name: DashboardAppLinkMessageHandler.name)
        let deviceSettingsMessageHandler = DashboardDeviceSettingsMessageHandler()
        self.deviceSettingsMessageHandler = deviceSettingsMessageHandler
        config.userContentController.addScriptMessageHandler(
            deviceSettingsMessageHandler, contentWorld: .page, name: Self.deviceSettingsMessageHandlerName)
        let browserMessageHandler = DashboardBrowserMessageHandler()
        config.userContentController.addScriptMessageHandler(
            browserMessageHandler, contentWorld: .page, name: DashboardBrowserMessageHandler.name)
        if shouldEnableUpdateBridge {
            // Handler presence is the Control UI feature probe; unsigned builds
            // and remote dashboards must not advertise a local app update.
            config.userContentController.add(messageHandler, name: Self.updateMessageHandlerName)
        }
        Self.installNativeChromeScript(into: config.userContentController, url: url)
        Self.installNativeAppLinkScript(into: config.userContentController, url: url)
        Self.installNativeGatewaysScript(into: config.userContentController, url: url, snapshot: gatewaySnapshot)
        Self.installNativeAuthScript(into: config.userContentController, url: url, auth: auth)

        self.webView = DashboardWebView(
            frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            configuration: config)
        // Let the native window show through before the document paints its theme.
        // underPageBackgroundColor alone leaves WebKit's initial white canvas opaque.
        self.webView.setValue(false, forKey: "drawsBackground")
        self.webView.underPageBackgroundColor = .windowBackgroundColor
        // The Control UI routes via pushState, so WKWebView's back-forward list
        // carries in-app navigation; the web titlebar buttons use this list.
        self.webView.allowsBackForwardNavigationGestures = true

        let readingDataStore = browserSessionLease?.session == nil ? websiteDataStore : WKWebsiteDataStore
            .nonPersistent()
        let dashboardPane = BrowserProfileImportBannerView.makeDashboardPane(webView: self.webView)
        self.nativeBrowser = DashboardNativeBrowserHost(
            dashboardWebView: self.webView,
            container: dashboardPane,
            websiteDataStore: readingDataStore,
            onStateChange: { [weak browserMessageHandler] state in
                browserMessageHandler?.owner?.publishBrowserState(state)
            })
        let preservedWindowFrame = reusingWindow?.frame
        let restoreKeyboardFocus = reusingWindow?.isKeyWindow == true
        let window = Self.makeWindow(
            contentView: dashboardPane,
            title: windowTitle,
            frameAutosaveName: windowAutosaveName,
            reusing: reusingWindow)
        super.init(window: window)
        // NSWindowController adopts its own frame state during initialization;
        // keep it aligned with the autosave name installed by makeWindow, then
        // re-correct placement in case the assignment re-applied a stale frame.
        windowFrameAutosaveName = windowAutosaveName
        if let preservedWindowFrame {
            window.setFrame(preservedWindowFrame, display: false)
        }
        WindowPlacement.ensureOnScreen(window: window, defaultSize: DashboardWindowLayout.windowSize)

        messageHandler.owner = self
        appLinkMessageHandler.owner = self
        deviceSettingsMessageHandler.owner = self
        browserMessageHandler.owner = self
        deviceSettingsMessageHandler.startObserving()
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.nativeBrowser.navigationDelegate = self
        self.nativeBrowser.uiDelegate = self
        self.nativeBrowser.onOpen = { [weak self] in
            guard let self else { return }
            self.browserProfileImportOfferIsArmed = true
            self.requestBrowserProfileImportOfferIfNeeded()
        }
        self.window?.delegate = self
        self.updateToolbarVisibility(isFullScreen: window.styleMask.contains(.fullScreen))
        self.installHistoryStateBridge()
        if restoreKeyboardFocus {
            window.makeFirstResponder(self.webView)
        }
    }

    func setUpdateBridgeEnabled(_ enabled: Bool) {
        let nextEnabled = self.updater?.isAvailable == true && enabled
        guard nextEnabled != self.updateBridgeEnabled else { return }
        self.updateBridgeEnabled = nextEnabled
        let controller = self.webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.updateMessageHandlerName)
        if nextEnabled {
            controller.add(self.messageHandler, name: Self.updateMessageHandlerName)
        }
        // The handler is the dashboard's ownership probe. Notify the live page so
        // its update target stays correct when connection mode or ownership changes.
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(
            "window.dispatchEvent(new CustomEvent('openclaw:native-update-availability-changed'))",
            url: self.currentURL))
    }

    // MARK: - WKUIDelegate

    /// Bridges JavaScript `window.confirm` calls in the embedded Control UI to a
    /// native confirmation sheet; without this callback, WebKit treats every
    /// confirm as Cancel and destructive dashboard actions silently stop.
    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void)
    {
        guard webView === self.webView || self.nativeBrowser.owns(webView) else {
            completionHandler(false)
            return
        }
        let alert = Self.makeJavaScriptConfirmAlert(
            message: message,
            host: frame.request.url?.host)
        if let window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(Self.javaScriptConfirmResult(for: response))
            }
            return
        }
        completionHandler(Self.javaScriptConfirmResult(for: alert.runModal()))
    }

    /// Bridges `<input type="file">` clicks in the embedded Control UI to a native
    /// `NSOpenPanel`; without a `WKUIDelegate`, WebKit silently drops the request
    /// and "Choose image" / file-picker buttons do nothing.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        guard webView === self.webView || self.nativeBrowser.owns(webView) else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        if let window {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            return
        }
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures _: WKWindowFeatures) -> WKWebView?
    {
        // WebKit reaches this callback only for user-allowed new-window requests;
        // every configuration disables automatic JavaScript windows.
        guard navigationAction.targetFrame == nil,
              webView === self.webView || self.nativeBrowser.owns(webView)
        else {
            return nil
        }
        if webView === self.webView, self.handleAppLinkNavigation(navigationAction) { return nil }
        // Reading-tab new windows stay native; dashboard new windows hand off
        // to the default browser.
        switch Self.newWindowAction(
            for: navigationAction.request.url,
            sourceIsNativeReadingTab: self.nativeBrowser.owns(webView))
        {
        case let .openTab(url):
            self.nativeBrowser.openNewWindow(url, opener: webView)
        case let .openExternal(url):
            self.openExternal(url)
        case .ignore:
            break
        }
        return nil
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(url: URL, auth: DashboardWindowAuth, updateBridgeEnabled: Bool? = nil) {
        self.update(url: url, auth: auth, updateBridgeEnabled: updateBridgeEnabled)
        self.show()
    }

    func loadInBackground(url: URL, auth: DashboardWindowAuth, restoringRoute: URL? = nil) {
        self.update(url: url, auth: auth, restoringRoute: restoringRoute)
    }

    func invalidateBrowserSession(error: GatewayBrowserSessionError? = nil) {
        self.invalidateGatewayHealth()
        if let route = self.browserSignInRoute, let url = self.webView.url,
           Self.isTrustedLinkSource(url, dashboardURL: route.baseURL)
        {
            self.browserSignInRoute = (route.baseURL, url)
        }
        if self.signedOut != nil {
            self.signedOutNeedsRefresh = true
            return
        }
        self.nativeBrowser.dispose()
        showFailure(
            title: error == .expired ? "Gateway sign-in expired" : "Gateway reconnecting",
            message: error?.localizedDescription ?? "The saved Gateway sign-in changed.",
            detail: "Reconnect in Connection → Gateways.",
            present: false,
            preservingPendingCommands: true)
    }

    /// Swap the dashboard to a new gateway endpoint without reordering the window:
    /// re-injects the native auth script for the new origin and reloads. Used when
    /// the remote tunnel is recreated on a new local port while the window stays
    /// open; ordering the window front here would steal focus on background
    /// tunnel recreation.
    func update(
        url: URL, auth: DashboardWindowAuth, updateBridgeEnabled: Bool? = nil, restoringRoute: URL? = nil)
    {
        let shouldReload = Self.shouldReloadDashboard(
            currentURL: self.currentURL,
            newURL: url,
            currentAuth: self.auth,
            newAuth: auth,
            hasUsableDocument: self.hasLiveContent || self.webView.isLoading || self.pendingLoad != nil,
            isShowingFailurePage: self.isShowingFailurePage)
        self.currentURL = url
        self.auth = auth
        if let updateBridgeEnabled {
            self.setUpdateBridgeEnabled(updateBridgeEnabled)
        }
        if shouldReload {
            self.refreshNativeScripts()
            let route = restoringRoute.flatMap { Self.isTrustedLinkSource($0, dashboardURL: url) ? $0 : nil }
            self.load(route ?? url)
        }
        self.requestBrowserProfileImportOfferIfNeeded()
    }

    /// Miniaturized windows report `isVisible == false` but must still follow
    /// endpoint changes so deminiaturizing does not land on a dead port.
    var isWindowOpen: Bool {
        guard let window, !self.isHiddenForExperience else { return false }
        return window.isVisible || window.isMiniaturized
    }

    var isHiddenForExperience: Bool {
        (self.window as? DashboardWindow)?.isHiddenForExperience == true
    }

    var hasRetainedWindow: Bool {
        self.isWindowOpen || self.isHiddenForExperience
    }

    func hideForExperience() {
        guard let window else { return }
        // Keep the document and drafts, but retire actions admitted by the
        // outgoing experience before a delayed lookup can show it again.
        (window as? DashboardWindow)?.isHiddenForExperience = self.hasRetainedWindow
        (window as? DashboardWindow)?.lifetimeRevision &+= 1
        self.advanceWindowIntent()
        self.notificationSourceID = UUID().uuidString
        self.pendingGatewaySwitch = nil
        _ = self.takePendingNativeActions()
        self.reconnectTask?.task.cancel()
        self.reconnectTask = nil
        self.browserSignInRoute = nil
        self.deviceSettingsMessageHandler.stopObserving()
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.isExcludedFromWindowsMenu = true
        window.orderOut(nil)
    }

    func show() {
        (self.window as? DashboardWindow)?.isHiddenForExperience = false
        self.window?.isExcludedFromWindowsMenu = false
        self.deviceSettingsMessageHandler.startObserving()
        if let window {
            let frame = window.frame
            if frame.width < DashboardWindowLayout.windowMinSize.width ||
                frame.height < DashboardWindowLayout.windowMinSize.height
            {
                window.setFrame(WindowPlacement.centeredFrame(size: DashboardWindowLayout.windowSize), display: false)
            }
        }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(self.webView)
        window?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        self.requestBrowserProfileImportOfferIfNeeded()
        self.refreshGatewayHealth()
    }

    func closeDashboard() {
        // Manager teardown must close even while a modal sheet disables the close button.
        self.window?.close()
    }

    func detachWindowForReplacement() -> NSWindow? {
        guard let window else { return nil }
        // Route changes replace the privileged document, not its native shell;
        // detaching first transfers AppKit ownership without a close/focus cycle.
        self.reconnectTask?.task.cancel()
        self.reconnectTask = nil
        self.browserSignInRoute = nil
        self.retirePendingLoad()
        self.deviceSettingsMessageHandler.stopObserving()
        self.webView.stopLoading()
        self.nativeBrowser.dispose()
        self.hasLiveContent = false
        self.invalidateGatewayHealth()
        self.onGatewayHealthChanged = nil
        self.onClosed = nil
        window.delegate = nil
        window.saveFrame(usingName: self.dashboardFrameAutosaveName)
        windowFrameAutosaveName = ""
        self.window = nil
        return window
    }

    private func load(_ url: URL) {
        self.retirePendingLoad()
        self.invalidateGatewayHealth()
        // Endpoint swaps must queue commands for the replacement document.
        self.hasLiveContent = false
        self.nativeCommandsReady = false
        self.isShowingFailurePage = false
        dashboardWindowLogger
            .debug("dashboard load \(GatewayEndpointStore.diagnosticURLString(for: url), privacy: .public)")
        guard let browserSessionLease else {
            self.webView.load(URLRequest(url: url))
            return
        }
        let generation = self.loadGeneration
        let contentController = self.webView.configuration.userContentController
        self.pendingLoad = Task { @MainActor [weak self] in
            do {
                try await browserSessionLease.prepare(for: url, in: contentController)
                guard let self, self.loadGeneration == generation, self.window != nil else { return }
                self.pendingLoad = nil
                self.webView.load(URLRequest(url: url))
            } catch {
                guard !Task.isCancelled, let self, self.loadGeneration == generation else { return }
                self.pendingLoad = nil
                self.showFailure(
                    title: "Gateway sign-in required",
                    message: error.localizedDescription,
                    detail: "Sign in again in Connection → Gateways.",
                    present: false,
                    preservingPendingCommands: true)
            }
        }
    }

    private func retirePendingLoad() {
        self.loadGeneration &+= 1
        self.pendingLoad?.cancel()
        self.pendingLoad = nil
    }

    private func requestBrowserProfileImportOfferIfNeeded() {
        guard !self.isHiddenForExperience,
              self.browserProfileImportOfferIsArmed,
              self.nativeBrowser.hasTabs,
              !self.didRequestBrowserProfileImportOffer
        else { return }
        if self.browserProfileImportOfferRequestIsInFlight {
            // Gateway readiness can arrive while the status poll awaits transport.
            // Latch one retry so in-flight dedupe does not discard that reconnect signal.
            self.browserProfileImportOfferRetryPending = true
            return
        }
        self.browserProfileImportOfferRequestIsInFlight = true
        Task { [weak self] in
            guard let self else { return }
            let didApply = await self.requestBrowserProfileImportOffer { [weak self] in
                guard let self else { return false }
                return !self.isHiddenForExperience && self.browserProfileImportOfferIsArmed &&
                    self.nativeBrowser.hasTabs &&
                    !self.didRequestBrowserProfileImportOffer
            }
            self.browserProfileImportOfferRequestIsInFlight = false
            let shouldRetry = self.browserProfileImportOfferRetryPending && !didApply
            self.browserProfileImportOfferRetryPending = false
            if didApply {
                self.didRequestBrowserProfileImportOffer = true
            } else if shouldRetry {
                self.requestBrowserProfileImportOfferIfNeeded()
            }
        }
    }

    func handleOnboardingCompletion() {
        // A Mac tab opened before onboarding leaves the one-shot armed. Retry at
        // the eligibility transition so it does not depend on later navigation.
        self.requestBrowserProfileImportOfferIfNeeded()
    }

    private func openExternal(_ url: URL) {
        guard Self.isExternalURL(url) || Self.isEditorURL(url) else { return }
        NSWorkspace.shared.open(url)
    }

    fileprivate func receiveMessage(_ message: WKScriptMessage) {
        switch message.name {
        case Self.linkMessageHandlerName: self.receiveLinkMessage(message)
        case Self.windowDragMessageHandlerName: self.receiveWindowDragMessage(message)
        case Self.updateMessageHandlerName: self.receiveUpdateMessage(message)
        case Self.commandsMessageHandlerName: self.receiveCommandsMessage(message)
        case Self.notificationsMessageHandlerName: self.receiveNotificationsMessage(message)
        case Self.gatewaysMessageHandlerName: self.receiveGatewaysMessage(message)
        default: break
        }
    }

    private func receiveLinkMessage(_ message: WKScriptMessage) {
        // The page-world handler is privileged. Accept only the main frame of
        // the current Control UI path; reading tabs never receive it.
        guard message.name == Self.linkMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let request = Self.linkRequest(from: message.body)
        else {
            return
        }

        switch request.target {
        case .inline, .external:
            // Older Control UI bundles still post inline; Mac tabs now use openclawBrowser.
            self.openExternal(request.url)
        }
    }

    /// The Control UI's passive chrome and the native failure page's background
    /// ask the window to take over the in-flight mouse gesture because
    /// WKWebView swallows titlebar-style drags.
    private func receiveWindowDragMessage(_ message: WKScriptMessage) {
        let isNativeFailureDocument = self.isShowingFailurePage &&
            message.frameInfo.request.url?.absoluteString == "about:blank" &&
            self.webView.url?.absoluteString == "about:blank"
        guard message.name == Self.windowDragMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              isNativeFailureDocument ||
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              Self.isWindowDragRequest(message.body),
              let window
        else {
            return
        }
        // The script message arrives async; during a press the app's current
        // event is still the initiating left-mouse-down (or a later drag). A
        // finished click leaves left-mouse-up here and starts no drag.
        guard let event = NSApp.currentEvent,
              event.type == .leftMouseDown || event.type == .leftMouseDragged,
              event.window === window
        else {
            return
        }
        DashboardWindowDragGesture.handle(event, in: window)
    }

    static func isWindowDragRequest(_ body: Any) -> Bool {
        guard let payload = body as? [String: Any] else { return false }
        return payload["type"] as? String == "window-drag"
    }

    private func receiveUpdateMessage(_ message: WKScriptMessage) {
        guard message.name == Self.updateMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              Self.isStartUpdateRequest(message.body),
              let updater
        else {
            return
        }
        // Eligibility is cached at window setup, but update.channel or launchd
        // ownership can change while the dashboard stays open. Revalidate here.
        guard DashboardManager.updateBridgeEnabled(mode: AppStateStore.shared.connectionMode) else {
            self.setUpdateBridgeEnabled(false)
            // JS treated its posted message as handled; return this click to
            // the gateway updater after withdrawing the native bridge.
            self.webView.evaluateJavaScript(Self.scopedDashboardScript(
                "window.dispatchEvent(new CustomEvent('openclaw:native-update-declined'))",
                url: self.currentURL))
            return
        }
        updater.checkForUpdates(nil)
    }

    static func isStartUpdateRequest(_ body: Any) -> Bool {
        guard let payload = body as? [String: Any] else { return false }
        return payload["type"] as? String == "start-update"
    }

    static func linkRequest(from body: Any) -> DashboardLinkRequest? {
        guard let payload = body as? [String: Any],
              payload["type"] as? String == "open-link",
              let rawURL = payload["url"] as? String,
              let url = URL(string: rawURL),
              let rawTarget = payload["target"] as? String,
              let target = DashboardLinkTarget(rawValue: rawTarget)
        else {
            return nil
        }
        switch target {
        case .inline:
            guard isHTTPURL(url) else { return nil }
        case .external:
            guard isExternalURL(url) else { return nil }
        }
        return DashboardLinkRequest(url: url, target: target)
    }

    func refreshNativeScripts() {
        let controller = self.webView.configuration.userContentController
        controller.removeAllUserScripts()
        Self.installNativeChromeScript(into: controller, url: self.currentURL)
        Self.installNativeAppLinkScript(into: controller, url: self.currentURL)
        Self.installNativeGatewaysScript(into: controller, url: self.currentURL, snapshot: self.gatewaySnapshot)
        Self.installNativeAuthScript(into: controller, url: self.currentURL, auth: self.auth)
    }

    private func installHistoryStateBridge() {
        self.canGoBackObservation = self.webView.observe(\.canGoBack, options: [
            .initial,
            .new,
        ]) { [weak self] _, _ in
            Task { @MainActor in
                self?.publishNativeHistoryState()
            }
        }
        self.canGoForwardObservation = self.webView.observe(\.canGoForward, options: [
            .initial,
            .new,
        ]) { [weak self] _, _ in
            Task { @MainActor in
                self?.publishNativeHistoryState()
            }
        }
    }

    private func publishNativeHistoryState() {
        let canGoBack = self.webView.canGoBack ? "true" : "false"
        let canGoForward = self.webView.canGoForward ? "true" : "false"
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(
            """
            window.__OPENCLAW_NATIVE_HISTORY__ = {canGoBack:\(canGoBack),canGoForward:\(canGoForward)};
            window.dispatchEvent(new CustomEvent('openclaw:native-history-state', \
            {detail:window.__OPENCLAW_NATIVE_HISTORY__}));
            """, url: self.currentURL))
    }

    private var activeNavigationWebView: WKWebView {
        var responderView = window?.firstResponder as? NSView
        while let view = responderView {
            if let webView = view as? WKWebView, self.nativeBrowser.owns(webView) {
                return webView
            }
            responderView = view.superview
        }
        return self.webView
    }

    private static func makeWindow(
        contentView: NSView,
        title: String,
        frameAutosaveName: String,
        reusing existingWindow: NSWindow?) -> NSWindow
    {
        let window = existingWindow ?? DashboardWindow(
            contentRect: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        let existingFrame = existingWindow?.frame
        let container = DashboardWindowContentView(frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize))
        contentView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentView)
        let topDragRegion = DashboardWindowDragRegionView()
        topDragRegion.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(topDragRegion)
        let topRightDragRegion = DashboardWindowDragRegionView()
        topRightDragRegion.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(topRightDragRegion)
        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: container.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            topDragRegion.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 78),
            topDragRegion.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -380),
            topDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            // Thin edge strip only: the web UI has no desktop topbar row, so a
            // taller region would swallow clicks meant for the top of the
            // content column (chat thread, page headers). The web titlebar
            // toolbar owns the larger drag surface beside the traffic lights.
            topDragRegion.heightAnchor.constraint(equalToConstant: 12),
            topRightDragRegion.leadingAnchor.constraint(equalTo: topDragRegion.trailingAnchor),
            topRightDragRegion.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            topRightDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            topRightDragRegion.heightAnchor.constraint(equalToConstant: 6),
        ])
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // An empty unified toolbar grows the transparent titlebar to 52pt so the
        // traffic lights sit vertically centered against the web titlebar row
        // (--openclaw-native-titlebar-height); without it they hug the top edge.
        window.toolbar = NSToolbar(identifier: "DashboardWindowTitlebar")
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        // The singleton manager, not AppKit state restoration, owns this window.
        window.isRestorable = false
        window.hasShadow = true
        window.backgroundColor = .windowBackgroundColor
        window.isOpaque = true
        let viewController = NSViewController()
        viewController.view = container
        window.contentViewController = viewController
        if existingWindow == nil {
            window.center()
        }
        window.minSize = DashboardWindowLayout.windowMinSize
        // Autosave restore first, placement correction last: a frame saved on
        // a since-disconnected monitor must not leave the window off-screen.
        window.setFrameAutosaveName(frameAutosaveName)
        if let existingFrame {
            window.setFrame(existingFrame, display: false)
        } else {
            WindowPlacement.ensureOnScreen(window: window, defaultSize: DashboardWindowLayout.windowSize)
        }
        return window
    }

    private func showLoadFailure(_ error: Error) {
        let nsError = error as NSError
        // A cancelled provisional navigation never commits, so the prior
        // document survives and stays command-capable; clearing live state
        // here would queue native commands forever with no reload to flush.
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            refreshNativeCommandReadiness()
            refreshGatewayHealth()
            return
        }
        prepareForFailure()
        let urlDescription = GatewayEndpointStore.diagnosticURLString(for: self.currentURL)
        dashboardWindowLogger.error(
            """
            dashboard load failed url=\(urlDescription, privacy: .public) \
            error=\(error.localizedDescription, privacy: .public)
            """)
        let html = DashboardFailurePage.html(
            title: "Dashboard unavailable",
            message: error.localizedDescription,
            detail: "The dashboard window is open, but the web UI could not load from this endpoint.",
            url: self.currentURL)
        self.webView.loadHTMLString(html, baseURL: nil)
    }
}

extension DashboardWindowController {
    private func prepareForFailure(preservingPendingCommands: Bool = false) {
        self.retirePendingLoad()
        self.invalidateGatewayHealth()
        self.hasLiveContent = false
        self.nativeCommandsReady = false
        self.isShowingFailurePage = true
        self.advanceNavigationGeneration()
        // A pending picker owns its successor's actions, independent of the failing document.
        guard self.pendingGatewaySwitch == nil else { return }
        // Transient reconnects retain generic commands; route-specific navigation expires.
        if !preservingPendingCommands {
            self.pendingNativeCommands = []
        }
        self.pendingNativeNavigation = nil
    }

    func showFailure(
        title: String,
        message: String,
        detail: String? = nil,
        present: Bool = true,
        preservingPendingCommands: Bool = false)
    {
        self.signedOut = nil
        self.showFailureHTML(
            DashboardFailurePage.html(title: title, message: message, detail: detail, url: nil),
            present: present,
            preservingPendingCommands: preservingPendingCommands)
    }

    func showSignedOut(_ page: DashboardFailurePage.SignedOut, present: Bool, autoStart: Bool) {
        self.signedOut = page
        self.signedOutNeedsRefresh = false
        self.showFailureHTML(DashboardFailurePage.html(signedOut: page), present: present)
        if autoStart { self.reconnectGateway(page.target) }
    }

    func reconnectGateway(_ target: DashboardGatewayTarget) {
        if self.signedOut == nil {
            self.reconnectLiveDashboard(target)
            return
        }
        guard let page = self.signedOut, page.target == target,
              case let .profile(id) = target, self.reconnectTask == nil else { return }
        self.showFailureHTML(DashboardFailurePage.html(signedOut: page, signingIn: true), present: false)
        let attempt = UUID()
        let progress = GatewayBrowserSignInProgress()
        self.signInProgress = progress
        progress.onChange = { [weak self, weak progress] in
            guard let self, let progress, self.reconnectTask?.id == attempt, self.isWindowOpen else { return }
            self.showFailureHTML(DashboardFailurePage.html(
                signedOut: page,
                signingIn: true,
                browserAttempt: progress.canOpenBrowser ? attempt : nil,
                error: progress.error), present: false)
        }
        let task = Task { @MainActor [weak self] in
            do {
                try await GatewayBrowserSignInCoordinator.reconnectGateway(id: id, progress: progress)
                // The profile-store notification replaces this document in its existing window.
            } catch {
                guard let self, self.reconnectTask?.id == attempt, self.isWindowOpen else { return }
                self.reconnectTask = nil
                self.signedOut = page
                self.showFailureHTML(
                    DashboardFailurePage.html(signedOut: page, error: error.localizedDescription), present: false)
            }
        }
        self.reconnectTask = (attempt, task)
    }

    private func reconnectLiveDashboard(_ target: DashboardGatewayTarget) {
        guard self.isWindowOpen, self.pendingGatewaySwitch == nil, self.reconnectTask == nil,
              self.auth.usesBrowserIdentity,
              let url = self.webView.url, Self.isTrustedLinkSource(url, dashboardURL: self.currentURL)
        else { return }
        guard self.browserSession != nil else {
            // Chrome and WebKit have separate cookies. Identity redirects must
            // return to this WebKit store, retaining the requested chat route.
            self.load(url)
            return
        }
        guard case let .profile(id) = target else { return }
        self.browserSignInRoute = (self.currentURL, url)
        let attempt = UUID()
        let task = Task { @MainActor [weak self] in
            do {
                try Task.checkCancellation()
                try await GatewayBrowserOnboardingController.withSignInProgress { [weak self] progress in
                    guard let self, self.reconnectTask?.id == attempt, self.isWindowOpen,
                          self.pendingGatewaySwitch == nil else { throw CancellationError() }
                    try await GatewayBrowserSignInCoordinator.reconnectGateway(id: id, progress: progress)
                }
                guard let self, self.reconnectTask?.id == attempt else { return }
                self.reconnectTask = nil
            } catch {
                guard let self, self.reconnectTask?.id == attempt else { return }
                self.reconnectTask = nil
                self.browserSignInRoute = nil
                guard self.isWindowOpen, !(error is CancellationError) else { return }
                DashboardManager.shared.presentGatewayError(
                    error, title: String(localized: "Gateway sign-in"), over: self.window)
            }
        }
        self.reconnectTask = (attempt, task)
    }

    func browserSignInReturnURL(session: GatewayBrowserSession?, dashboardURL: URL) -> URL? {
        guard let route = self.browserSignInRoute,
              let previous = self.browserSession, let session,
              previous.browserDataPrincipal == session.browserDataPrincipal,
              DashboardManager.notificationRoute(route.baseURL) == DashboardManager.notificationRoute(dashboardURL),
              Self.isTrustedLinkSource(route.url, dashboardURL: dashboardURL)
        else { return nil }
        return route.url
    }

    func cancelGatewayReconnect(_ target: DashboardGatewayTarget) {
        guard let page = self.signedOut, page.target == target, let reconnectTask else { return }
        self.reconnectTask = nil
        reconnectTask.task.cancel()
        self.showFailureHTML(
            DashboardFailurePage.html(signedOut: page, error: String(localized: "Sign-in cancelled. Try again.")),
            present: false)
    }

    func openGatewaySignInBrowser(_ target: DashboardGatewayTarget, attempt: UUID) {
        guard self.signedOut?.target == target, self.reconnectTask?.id == attempt,
              let progress = self.signInProgress, let action = progress.handoff else { return }
        progress.openBrowser(action)
    }

    private func showFailureHTML(
        _ html: String, present: Bool, preservingPendingCommands: Bool = false)
    {
        let pendingNavigation = self.signedOut == nil ? nil : self.pendingNativeNavigation
        self.prepareForFailure(preservingPendingCommands: preservingPendingCommands || self.signedOut != nil)
        self.pendingNativeNavigation = pendingNavigation
        if self.signedOut == nil { self.currentURL = URL(string: "about:blank")! }
        self.auth = DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        self.setUpdateBridgeEnabled(false)
        self.refreshNativeScripts()
        self.webView.stopLoading()
        self.webView.loadHTMLString(html, baseURL: nil)
        if present {
            self.show()
        }
    }

    typealias PendingNativeActions = (commands: [DashboardNativeCommand], navigation: DashboardNativeNavigation?)

    func takePendingNativeActions() -> PendingNativeActions {
        defer {
            self.pendingNativeCommands = []
            self.pendingNativeNavigation = nil
            self.advanceNavigationGeneration()
        }
        return (self.pendingNativeCommands, self.pendingNativeNavigation)
    }

    func restorePendingNativeActions(_ actions: PendingNativeActions, preservingNavigation: Bool) {
        // Transfer already admitted intent without advancing the native window's generation again.
        self.pendingNativeCommands = actions.commands
        self.pendingNativeNavigation = preservingNavigation ? actions.navigation : nil
    }

    func retirePendingSessionCommands() {
        self.pendingNativeCommands.removeAll(where: \.supersedesPendingNavigation)
        self.browserSignInRoute = nil
    }

    var pendingGatewaySwitch: DashboardGatewaySwitchIntent? {
        get { (window as? DashboardWindow)?.pendingGatewaySwitch }
        set { (window as? DashboardWindow)?.pendingGatewaySwitch = newValue }
    }

    func navigateBack() {
        self.activeNavigationWebView.goBack()
    }

    func navigateForward() {
        self.activeNavigationWebView.goForward()
    }

    fileprivate func closeFocusedPanelOrWindow() {
        guard let window else { return }
        guard self.canDispatchNativeCommands else {
            window.performClose(nil)
            return
        }
        let sourceID = self.notificationSourceID
        let intent = self.windowIntentGeneration
        let lifetime = self.windowLifetimeRevision
        let browserScope = self.nativeBrowser.presentationScope(for: self.activeNavigationWebView)
        let detail = browserScope.map { "{browserScope:\(WebViewJavaScriptSupport.jsValue($0))}" } ?? "null"
        let script = Self.scopedDashboardScript("""
        return !window.dispatchEvent(new CustomEvent('openclaw:native-close-focused-panel', {
          cancelable: true, detail: \(detail)
        }));
        """, url: self.currentURL)
        Task { @MainActor [weak self, weak window] in
            guard let self, let window else { return }
            let handled = try? await self.webView.evaluateJavaScript(script)
            // A delayed reply must not close a replacement/reopened window or a
            // new document. Close intent is never queued for a future dashboard.
            guard self.window === window, self.notificationSourceID == sourceID,
                  self.windowIntentGeneration == intent, self.windowLifetimeRevision == lifetime,
                  !self.webView.isLoading, handled as? Bool != true else { return }
            window.performClose(nil)
        }
    }

    private static func makeJavaScriptConfirmAlert(message: String, host: String?) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "OpenClaw Dashboard"
        if let host, !host.isEmpty {
            alert.informativeText = "\(host) is asking:\n\n\(message)"
        } else {
            alert.informativeText = message
        }
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert
    }

    private static func javaScriptConfirmResult(
        for response: NSApplication.ModalResponse)
        -> Bool
    {
        response == .alertFirstButtonReturn
    }

    /// Commands are deliverable when a document is live or a load is in flight
    /// (the queue flushes at `didFinish`). A failure page, or a terminally
    /// cancelled load with no successor, needs a reload before dispatch —
    /// otherwise queued ⌘N/⌘K would wait on a `didFinish` that never comes.
    var canDeliverNativeCommands: Bool {
        !self.isShowingFailurePage && (self.hasLiveContent || self.webView.isLoading || self.pendingLoad != nil)
    }

    private var isTrustedDashboardDocument: Bool {
        Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }

    private var canDispatchNativeCommands: Bool {
        // Older shared-credential Gateways predate the shell-ready signal.
        // Personal browser sign-in requires the current Control UI's listener-owned fact.
        self.hasLiveContent && self.pendingGatewaySwitch == nil && self.isTrustedDashboardDocument &&
            (!self.auth.usesBrowserIdentity || self.nativeCommandsReady)
    }

    private func receiveCommandsMessage(_ message: WKScriptMessage) {
        guard message.name == Self.commandsMessageHandlerName,
              message.webView === self.webView, message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL)
        else { return }
        self.refreshNativeCommandReadiness()
    }

    private func refreshNativeCommandReadiness() {
        guard self.auth.usesBrowserIdentity else { return }
        let sourceID = self.notificationSourceID
        let sourceURL = self.currentURL
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Messages only wake the read. A previous same-URL document cannot
            // attest that the currently displayed sign-in page has command listeners.
            let ready = try? await self.webView.evaluateJavaScript(Self.scopedDashboardScript(
                "return window.__OPENCLAW_NATIVE_COMMANDS_READY__ === true;", url: sourceURL))
            guard self.notificationSourceID == sourceID, self.currentURL == sourceURL,
                  !self.webView.isLoading else { return }
            self.nativeCommandsReady = ready as? Bool == true
            self.flushReadyNativeActions()
        }
    }

    func refreshGatewayHealth() {
        self.gatewayHealthReadRevision &+= 1
        guard self.hasLiveContent, self.hasRetainedWindow, self.hasCurrentBrowserSession,
              !self.isShowingFailurePage, !self.webView.isLoading, self.isTrustedDashboardDocument,
              let window else { return }
        let revision = self.gatewayHealthReadRevision
        let sourceID = self.notificationSourceID
        let sourceURL = self.currentURL
        let lifetime = self.windowLifetimeRevision
        // A wake-up carries no health evidence: read the current main document,
        // even when a retired same-URL document sent the message.
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(
            "return window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__;", url: sourceURL))
        { [weak self, weak window] value, _ in
            guard let self, let window, self.window === window,
                  self.gatewayHealthReadRevision == revision, self.notificationSourceID == sourceID,
                  self.windowLifetimeRevision == lifetime, self.currentURL == sourceURL,
                  self.hasLiveContent, self.hasRetainedWindow, self.hasCurrentBrowserSession,
                  !self.isShowingFailurePage, !self.webView.isLoading, self.isTrustedDashboardDocument
            else { return }
            // The web connection can change independently of the native picker.
            // Its health must never be attributed to this window's saved Gateway.
            let health: DashboardGatewayHealth? = if let report = value as? [String: Any],
                                                     let expectedURL = self.auth.gatewayUrl,
                                                     report["gatewayUrl"] as? String == expectedURL
            {
                (report["health"] as? String).flatMap(DashboardGatewayHealth.init(rawValue:))
            } else {
                nil
            }
            self.setGatewayHealth(health)
        }
    }

    private func invalidateGatewayHealth() {
        self.gatewayHealthReadRevision &+= 1
        self.setGatewayHealth(nil)
    }

    private func setGatewayHealth(_ health: DashboardGatewayHealth?) {
        guard self.gatewayHealth != health else { return }
        self.gatewayHealth = health
        self.onGatewayHealthChanged?()
    }

    private func flushReadyNativeActions() {
        guard self.canDispatchNativeCommands else { return }
        self.flushPendingNativeCommands()
        self.flushPendingNativeNavigation()
    }

    /// The canonical Dashboard mount URL supplied by the manager. WebKit route
    /// loads and SPA history do not mutate it, so native fallbacks stay rooted.
    var dashboardBaseURL: URL {
        self.currentURL
    }

    func windowDidEnterFullScreen(_: Notification) {
        self.updateToolbarVisibility(isFullScreen: true)
    }

    func windowDidExitFullScreen(_: Notification) {
        self.updateToolbarVisibility(isFullScreen: false)
    }

    private func updateToolbarVisibility(isFullScreen: Bool) {
        // Apply completed transitions; failed transitions keep their previous chrome.
        // Reused windows also pass through this owner during initialization.
        self.window?.toolbar?.isVisible = !isFullScreen
    }

    func windowWillClose(_: Notification) {
        self.reconnectTask?.task.cancel()
        self.reconnectTask = nil
        self.browserSignInRoute = nil
        self.retirePendingLoad()
        (self.window as? DashboardWindow)?.lifetimeRevision &+= 1
        (self.window as? DashboardWindow)?.isHiddenForExperience = false
        self.deviceSettingsMessageHandler.stopObserving()
        self.advanceWindowIntent()
        self.advanceNavigationGeneration()
        self.hasLiveContent = false
        self.nativeCommandsReady = false
        self.invalidateGatewayHealth()
        self.pendingNativeCommands = []
        self.pendingNativeNavigation = nil
        self.pendingGatewaySwitch = nil
        self.webView.stopLoading()
        self.nativeBrowser.dispose()
        self.onClosed?()
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void)
    {
        guard webView === self.webView else {
            decisionHandler(.deny)
            return
        }
        let mediaTypes: [AVMediaType]
        switch type {
        case .camera:
            mediaTypes = [.video]
        case .microphone:
            mediaTypes = [.audio]
        case .cameraAndMicrophone:
            mediaTypes = [.video, .audio]
        @unknown default:
            decisionHandler(.deny)
            return
        }
        guard frame.isMainFrame,
              Self.isTrustedMediaCaptureOrigin(
                  protocol: origin.protocol,
                  host: origin.host,
                  port: origin.port,
                  dashboardURL: self.currentURL)
        else {
            decisionHandler(.prompt)
            return
        }
        let authorized = mediaTypes.allSatisfy { AVCaptureDevice.authorizationStatus(for: $0) == .authorized }
        decisionHandler(authorized ? .grant : .prompt)
    }

    static func shouldReloadDashboard(
        currentURL: URL,
        newURL: URL,
        currentAuth: DashboardWindowAuth,
        newAuth: DashboardWindowAuth,
        hasUsableDocument: Bool,
        isShowingFailurePage: Bool) -> Bool
    {
        // Token changes surface in the URL fragment, but password-only auth keeps
        // the URL identical; comparing auth prevents serving stale credentials.
        // An in-flight load counts as usable so opening mid-preload does not
        // cancel and restart it — unless the in-flight document is the failure
        // page, which must always be replaced.
        currentURL != newURL || currentAuth != newAuth || isShowingFailurePage || !hasUsableDocument
    }

    func dispatchNativeCommand(_ command: DashboardNativeCommand) {
        if command.supersedesPendingNavigation {
            self.advanceWindowIntent()
            self.advanceNavigationGeneration()
        }
        guard self.canDispatchNativeCommands, self.isWindowOpen
        else {
            // Ordered queue, duplicates included: two ⌘K presses while loading
            // must toggle twice, and ⌘N followed by ⌘K must deliver both.
            if command.supersedesPendingNavigation {
                self.pendingNativeNavigation = nil
            }
            self.pendingNativeCommands.append(command)
            return
        }
        self.evaluateNativeCommand(command)
    }

    private func evaluateNativeCommand(_ command: DashboardNativeCommand) {
        guard let fallback = command.legacyFallbackEventName else {
            self.webView.evaluateJavaScript(Self.scopedDashboardScript(
                "window.dispatchEvent(new CustomEvent(\(WebViewJavaScriptSupport.jsValue(command.rawValue))))",
                url: self.currentURL))
            return
        }
        // Older gateway-served bundles predate the toggle event but handled ⌘K
        // via page keydown, which the menu item now intercepts. A handler that
        // knows the new event calls preventDefault; otherwise fall back to the
        // legacy open-only event so ⌘K keeps working against old bundles.
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(
            """
            (() => {
              const handled = !window.dispatchEvent(
                new CustomEvent(\(WebViewJavaScriptSupport.jsValue(command.rawValue)), {cancelable: true}));
              if (!handled) {
                window.dispatchEvent(new CustomEvent(\(WebViewJavaScriptSupport.jsValue(fallback))));
              }
            })();
            """, url: self.currentURL))
    }

    private func flushPendingNativeCommands() {
        let commands = self.pendingNativeCommands
        self.pendingNativeCommands = []
        for command in commands {
            self.evaluateNativeCommand(command)
        }
    }

    func dispatchNativeNavigation(_ navigation: DashboardNativeNavigation) {
        self.advanceWindowIntent()
        self.advanceNavigationGeneration()
        guard self.canDispatchNativeCommands else {
            // Navigation is state selection, so only the newest destination matters while loading.
            self.pendingNativeNavigation = navigation
            return
        }
        self.evaluateNativeNavigation(navigation)
    }

    private func evaluateNativeNavigation(_ navigation: DashboardNativeNavigation) {
        let generation = self.navigationGeneration
        let sourceURL = self.currentURL
        let searchLiteral = navigation.search.map { WebViewJavaScriptSupport.jsValue($0) } ?? "undefined"
        let script =
            """
            return !window.dispatchEvent(new CustomEvent('openclaw:native-navigate', {
              cancelable: true,
              detail: {path: \(WebViewJavaScriptSupport.jsValue(navigation.path)), search: \(searchLiteral)}
            }));
            """
        Task { @MainActor [weak self] in
            guard let self, !self.isHiddenForExperience,
                  self.navigationFallbackIsCurrent(generation: generation, sourceURL: sourceURL) else { return }
            let result = try? await self.webView.evaluateJavaScript(Self.scopedDashboardScript(script, url: sourceURL))
            let handled = result as? Bool
            // Async completions may return after another route or New Session intent.
            // Only the newest navigation intent may load its fallback URL.
            guard handled != true, self.isTrustedDashboardDocument,
                  self.navigationFallbackIsCurrent(generation: generation, sourceURL: sourceURL)
            else { return }
            self.load(navigation.fallbackURL)
        }
    }

    var windowIntentGeneration: UInt64? {
        (window as? DashboardWindow)?.userIntentGeneration
    }

    var windowLifetimeRevision: UInt64? {
        (self.window as? DashboardWindow)?.lifetimeRevision
    }

    private func advanceWindowIntent() {
        (window as? DashboardWindow)?.userIntentGeneration &+= 1
    }

    private func advanceNavigationGeneration() {
        self.navigationGeneration &+= 1
    }

    private func navigationFallbackIsCurrent(generation: UInt64, sourceURL: URL) -> Bool {
        self.navigationGeneration == generation && self.currentURL == sourceURL
    }

    private func flushPendingNativeNavigation() {
        guard let navigation = pendingNativeNavigation else { return }
        self.pendingNativeNavigation = nil
        self.evaluateNativeNavigation(navigation)
    }
}

extension DashboardWindowController {
    func receiveAppLinkMessage(_ message: WKScriptMessage) {
        guard message.name == DashboardAppLinkMessageHandler.name,
              message.world === DashboardAppLinkMessageHandler.world,
              message.webView === self.webView, message.frameInfo.isMainFrame,
              self.isWindowOpen, self.canDispatchNativeCommands, self.hasCurrentBrowserSession,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let rawURL = message.body as? String, let url = URL(string: rawURL),
              url.scheme?.lowercased() == "openclaw", DeepLinkParser.parse(url) != nil else { return }
        self.openAppLink(url)
    }

    private func handleAppLinkNavigation(_ action: WKNavigationAction) -> Bool {
        guard let url = action.request.url,
              action.targetFrame == nil || action.targetFrame?.isMainFrame == true,
              self.isWindowOpen, self.canDispatchNativeCommands, self.hasCurrentBrowserSession,
              Self.shouldHandleAppLinkNavigation(
                  url,
                  navigationType: action.navigationType,
                  buttonNumber: action.buttonNumber,
                  sourceURL: action.sourceFrame.request.url,
                  sourceIsMainFrame: action.sourceFrame.isMainFrame,
                  dashboardURL: self.currentURL)
        else { return false }
        self.openAppLink(url)
        return true
    }

    private func openAppLink(_ url: URL) {
        let generation = self.navigationGeneration
        let sourceURL = self.currentURL
        let lifetime = self.windowLifetimeRevision
        let sourceID = self.notificationSourceID
        Task { @MainActor [weak self] in
            guard let self, self.isWindowOpen, self.hasCurrentBrowserSession,
                  self.windowLifetimeRevision == lifetime, self.notificationSourceID == sourceID,
                  self.navigationFallbackIsCurrent(generation: generation, sourceURL: sourceURL)
            else { return }
            await DeepLinkHandler.shared.handle(url: url)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        let isDashboardWebView = webView === self.webView
        let nativeTab = self.nativeBrowser.browserTab(for: webView)
        guard isDashboardWebView || nativeTab != nil else {
            decisionHandler(.cancel)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(isDashboardWebView ? .allow : .cancel)
            return
        }
        if let nativeTab {
            let isMainFrame = navigationAction.targetFrame?.isMainFrame == true
            if isMainFrame {
                nativeTab.navigationWasUserActivated = Self.shouldOpenExternalDashboardNavigation(
                    url,
                    navigationType: navigationAction.navigationType,
                    buttonNumber: navigationAction.buttonNumber)
            }
            // Page-initiated downloads keep their external-browser behavior.
            // The explicit toolbar action owns the native Save dialog.
            if navigationAction.shouldPerformDownload {
                if Self.shouldOpenExternalDashboardNavigation(
                    url,
                    navigationType: navigationAction.navigationType,
                    buttonNumber: navigationAction.buttonNumber)
                {
                    self.openExternal(url)
                }
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame == nil {
                self.decideTargetlessNavigation(
                    url,
                    navigationType: navigationAction.navigationType,
                    buttonNumber: navigationAction.buttonNumber,
                    allowEditorURLs: false,
                    decisionHandler: decisionHandler)
                return
            }
            if Self.shouldAllowBrowserNavigation(to: url, isMainFrame: isMainFrame) ||
                url.absoluteString == "about:blank"
            {
                if isMainFrame {
                    self.nativeBrowser.navigationWillStart(url, in: webView)
                }
                decisionHandler(.allow)
                return
            }
            // Mac tabs are HTTP(S) reading surfaces. Only the trusted
            // dashboard bridge may ask macOS to launch mail or phone URLs.
            decisionHandler(.cancel)
            return
        }
        // The dashboard's user-activated app links use the existing deep-link
        // owner. Reading tabs and subframes never reach this privileged handoff.
        if self.handleAppLinkNavigation(navigationAction) {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame == nil {
            let allowEditorURLs = Self.shouldAllowEditorURLLaunch(
                from: navigationAction.sourceFrame.request.url,
                isMainFrame: navigationAction.sourceFrame.isMainFrame,
                dashboardURL: self.currentURL)
            self.decideTargetlessNavigation(
                url,
                navigationType: navigationAction.navigationType,
                buttonNumber: navigationAction.buttonNumber,
                allowEditorURLs: allowEditorURLs,
                decisionHandler: decisionHandler)
            return
        }
        if Self.shouldAllowIdentityNavigation(
            to: url,
            auth: self.auth,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
            sourceIsDashboard: self.isTrustedDashboardDocument &&
                (!self.auth.usesBrowserIdentity || self.nativeCommandsReady),
            navigationType: navigationAction.navigationType)
        {
            decisionHandler(.allow)
            return
        }
        if Self.shouldAllowNavigation(
            to: url,
            dashboardURL: self.currentURL,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true)
        {
            decisionHandler(.allow)
            return
        }
        // Back/forward can reach entries from a previous gateway endpoint after
        // a tunnel/port swap; opening those externally would launch a dead URL
        // in the browser, so swallow the traversal instead.
        if navigationAction.navigationType == .backForward {
            decisionHandler(.cancel)
            return
        }
        if Self.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationAction.navigationType,
            buttonNumber: navigationAction.buttonNumber)
        {
            self.openExternal(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if self.nativeBrowser.owns(webView) {
            self.nativeBrowser.navigationDidStart(navigation, in: webView)
        } else if webView === self.webView {
            self.nativeCommandsReady = false
        }
    }

    /// The displayed document is replaced at commit, not at provisional start.
    /// Clearing here covers page/WebKit-initiated main-frame navigations that
    /// never pass through `load(_:)`, so commands queue for the new document.
    func webView(_ webView: WKWebView, didCommit _: WKNavigation!) {
        guard webView === self.webView else { return }
        self.notificationSourceID = UUID().uuidString
        self.invalidateGatewayHealth()
        self.deviceSettingsMessageHandler.cancelRequests()
        self.nativeBrowser.releaseAllScopes()
        self.hasLiveContent = false
        self.nativeCommandsReady = false
        // Swipe-back/⌘[ can leave the failure page through WKWebView history
        // without a `load(_:)`; a committed http(s) document is a real
        // dashboard again (the failure page itself commits as about:blank).
        if webView.url?.scheme?.lowercased().hasPrefix("http") == true {
            self.isShowingFailurePage = false
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if self.nativeBrowser.owns(webView) {
            self.nativeBrowser.navigationDidFinish(navigation, for: webView)
        } else if webView === self.webView {
            guard !self.isShowingFailurePage else { return }
            // A finished sign-in document is usable but never receives native
            // commands. Keep pending intent until the verified dashboard returns.
            self.hasLiveContent = true
            guard self.isTrustedDashboardDocument else { return }
            self.deviceSettingsMessageHandler.refresh(refreshAvailability: true)
            self.publishNativeHistoryState()
            self.nativeBrowser.scheduleStatePush()
            self.refreshNativeCommandReadiness()
            self.refreshGatewayHealth()
            self.flushReadyNativeActions()
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error)
    {
        self.webView(webView, didFail: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        if self.nativeBrowser.owns(webView) {
            self.nativeBrowser.navigationDidFail(for: webView)
            return
        }
        guard webView === self.webView else { return }
        self.showLoadFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView {
            self.hasLiveContent = false
            self.nativeCommandsReady = false
            self.invalidateGatewayHealth()
        } else if self.nativeBrowser.owns(webView) {
            webView.reload()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        guard let tab = self.nativeBrowser.browserTab(for: webView) else {
            decisionHandler(.allow)
            return
        }
        let userActivated = tab.navigationWasUserActivated
        if navigationResponse.isForMainFrame {
            // Consume the main-frame action; subframe responses cannot borrow it.
            tab.navigationWasUserActivated = false
        }
        switch Self.browserResponseAction(
            for: navigationResponse.response.url,
            canShowMIMEType: navigationResponse.canShowMIMEType,
            isMainFrame: navigationResponse.isForMainFrame,
            userActivated: userActivated)
        {
        case .allow:
            decisionHandler(.allow)
        case let .openExternal(url):
            self.openExternal(url)
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    private func decideTargetlessNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        switch Self.targetlessNavigationAction(
            for: url,
            navigationType: navigationType,
            buttonNumber: buttonNumber,
            allowEditorURLs: allowEditorURLs)
        {
        case .allow:
            decisionHandler(.allow)
        case .openExternal:
            self.openExternal(url)
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }
}

#if DEBUG
extension DashboardWindowController {
    var _testUserScripts: [WKUserScript] {
        self.webView.configuration.userContentController.userScripts
    }

    var _testUpdateBridgeAvailable: Bool {
        self.updateBridgeEnabled
    }

    var _testTLSParams: GatewayTLSParams? {
        self.tlsParams
    }

    var _testDashboardDataStore: WKWebsiteDataStore {
        self.webView.configuration.websiteDataStore
    }

    var _testAllowsBackForwardGestures: Bool {
        self.webView.allowsBackForwardNavigationGestures
    }

    var _testPendingNativeCommands: [DashboardNativeCommand] {
        self.pendingNativeCommands
    }

    var _testPendingNativeNavigation: DashboardNativeNavigation? {
        self.pendingNativeNavigation
    }

    var _testNavigationGeneration: UInt64 {
        self.navigationGeneration
    }

    func _testNavigationFallbackIsCurrent(generation: UInt64, sourceURL: URL) -> Bool {
        self.navigationFallbackIsCurrent(generation: generation, sourceURL: sourceURL)
    }

    var _testNavigationWebViewIdentity: ObjectIdentifier {
        ObjectIdentifier(self.activeNavigationWebView)
    }

    var _testDashboardWebViewIdentity: ObjectIdentifier {
        ObjectIdentifier(self.webView)
    }

    static func _testJavaScriptConfirmAlert(message: String, host: String?) -> NSAlert {
        self.makeJavaScriptConfirmAlert(message: message, host: host)
    }

    static func _testJavaScriptConfirmResult(for response: NSApplication.ModalResponse) -> Bool {
        self.javaScriptConfirmResult(for: response)
    }
}
#endif
