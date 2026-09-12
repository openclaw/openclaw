import Foundation
import OpenClawKit
import WebKit

extension DashboardManager {
    struct AuxiliaryWindowInstance {
        var target: DashboardGatewayTarget
        var controller: DashboardWindowController
    }

    struct WindowConfiguration {
        let url: URL
        let auth: DashboardWindowAuth
        let tlsParams: GatewayTLSParams?
        let mode: AppState.ConnectionMode
        let displayName: String
        var browserSession: GatewayBrowserSession?
        var signedOut: DashboardFailurePage.SignedOut?
        var autoStartSignIn = false
    }

    struct SupersededDashboardPresentation: Error {}

    struct NavigationIntent {
        let id = UUID()
        let windowID: ObjectIdentifier?
    }

    final class ProfileObservation {
        let id = UUID()
        var task: Task<Void, Never>?
        var snapshot: GatewayConnection.PushDelivery?
        var revision: UInt64 = 0
        var needsRefresh = false
    }

    static let shared: DashboardManager = {
        #if DEBUG
        // UI fixtures instantiate shared views; their notifications must not start
        // live profile/Keychain observers outside the fixture's injected manager.
        if ProcessInfo.processInfo.isRunningTests {
            return DashboardManager._testMake()
        }
        #endif
        return DashboardManager(
            websiteDataStore: .default(),
            selection: .shared,
            automaticGatewayProfileRefreshEnabled:
            AppLaunchRuntimePlan.current.allowsGatewayUIKeychainAccess)
    }()
}

#if DEBUG
extension DashboardManager {
    /// Test instances skip `observeEndpointChanges()` so the shared endpoint
    /// store cannot race test-driven `handleEndpointState` calls.
    static func _testMake(
        websiteDataStore: WKWebsiteDataStore = .nonPersistent(),
        selection: MacGatewaySelectionPreferences? = nil,
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { $0.token },
        connectionProvider: @escaping @Sendable (DashboardGatewayTarget) async -> GatewayConnection = {
            await DashboardManager.gatewayConnection(for: $0)
        },
        browserIdentityURLProvider: (@Sendable (DashboardGatewayTarget, GatewayConnection.Config) async throws
            -> URL?)? = { _, _ in nil },
        routeProbe: @escaping @Sendable (DashboardRouteProbePurpose) async -> Void = { _ in },
        endpointStateProvider: @escaping @Sendable () async -> GatewayEndpointState = {
            .unavailable(mode: .unconfigured, reason: "not configured")
        },
        observeGatewayChanges: Bool = false,
        automaticGatewayProfileRefreshEnabled: Bool = true,
        primaryEndpointProvider: (@Sendable (AppState.ConnectionMode) async throws
            -> GatewayConnection.EndpointSnapshot)? = nil,
        profileEndpointProvider: @escaping @Sendable (String) async throws
            -> GatewayConnection.EndpointSnapshot = { _ in throw MacGatewayProfileError.profileNotFound },
        gatewayEntriesProvider: (@MainActor () async throws -> [DashboardGatewayEntry])? = { [] })
        -> DashboardManager
    {
        let manager = DashboardManager(
            websiteDataStore: websiteDataStore,
            selection: selection ?? MacGatewaySelectionPreferences(
                defaults: UserDefaults(suiteName: "DashboardSelectionTests.\(UUID().uuidString)")!),
            authTokenProvider: authTokenProvider,
            connectionProvider: connectionProvider,
            browserIdentityURLProvider: browserIdentityURLProvider,
            routeProbe: routeProbe,
            endpointStateProvider: endpointStateProvider,
            observeGatewayChanges: observeGatewayChanges,
            automaticGatewayProfileRefreshEnabled: automaticGatewayProfileRefreshEnabled,
            mainWindowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        manager.testPrimaryEndpointProvider = primaryEndpointProvider
        manager.testProfileEndpointProvider = profileEndpointProvider
        manager.testGatewayEntriesProvider = gatewayEntriesProvider
        return manager
    }
}
#endif

extension DashboardManager {
    nonisolated static let failureURL = URL(string: "about:blank")!

    nonisolated static let browserSessionRenewalLeadTime: TimeInterval = 15 * 60

    nonisolated static func requiresBrowserSignIn(
        error: Error?, expiresAt: Date?, userGesture: Bool, now: Date = Date()) -> Bool
    {
        if let error { return error as? GatewayBrowserSessionError == .expired }
        guard userGesture, let expiresAt else { return false }
        return expiresAt <= now.addingTimeInterval(Self.browserSessionRenewalLeadTime)
    }

    func canFocusWithoutReload(_ controller: DashboardWindowController, userGesture: Bool) -> Bool {
        controller.hasCurrentBrowserSession && !controller.isShowingFailurePage &&
            !Self.requiresBrowserSignIn(
                error: nil, expiresAt: controller.browserSession?.expiresAt, userGesture: userGesture)
    }

    func loadWindow(
        _ controller: DashboardWindowController, configuration: WindowConfiguration, present: Bool)
    {
        if let page = configuration.signedOut {
            controller.showSignedOut(page, present: present, autoStart: configuration.autoStartSignIn)
        } else if present {
            controller.show(url: configuration.url, auth: configuration.auth)
        } else {
            controller.loadInBackground(url: configuration.url, auth: configuration.auth)
        }
    }
}

extension DashboardManager.WindowConfiguration {
    init?(
        signedOut error: Error,
        profileID: String,
        name: String?,
        endpoint: GatewayConnection.EndpointSnapshot?,
        userGesture: Bool) throws
    {
        let profile: MacGatewayProfile
        let expiry: Date
        if let context = error as? MacGatewayProfileStore.BrowserSignInRequired {
            guard context.profile.id == profileID else { return nil }
            profile = context.profile
            expiry = context.expiresAt
        } else {
            guard DashboardManager.requiresBrowserSignIn(error: error, expiresAt: nil, userGesture: userGesture),
                  let endpoint, let session = endpoint.browserSession else { return nil }
            profile = MacGatewayProfile(
                id: profileID, name: name ?? endpoint.config.url.host ?? "Gateway", url: endpoint.config.url)
            expiry = session.expiresAt
        }
        try self.init(
            url: GatewayEndpointStore.dashboardURL(for: (profile.url, nil, nil), mode: .remote),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            tlsParams: nil,
            mode: .remote,
            displayName: profile.name,
            signedOut: DashboardFailurePage.SignedOut(
                target: .profile(profile.id),
                name: profile.name,
                host: profile.url.host ?? profile.url.absoluteString,
                expiresAt: expiry),
            autoStartSignIn: userGesture)
    }
}

extension DashboardManager {
    func autosaveName(for target: DashboardGatewayTarget) -> String {
        switch target {
        case .primary:
            self.mainWindowAutosaveName
        case .local:
            "\(self.mainWindowAutosaveName)-local"
        case let .profile(profileID):
            "\(self.mainWindowAutosaveName)-\(profileID)"
        }
    }
}

extension DashboardManager {
    func dashboardConfiguration(
        endpoint: GatewayConnection.EndpointSnapshot,
        mode: AppState.ConnectionMode,
        target: DashboardGatewayTarget,
        token: String?) async throws -> WindowConfiguration
    {
        let config = endpoint.config
        let browserSession = endpoint.browserSession
        try browserSession?.validate(for: config.url)
        let identityURL = mode == .remote
            ? try await browserIdentityURLProvider(target, config)
            : nil
        let dashboardConfig: GatewayConnection.Config = browserSession == nil
            ? config : (url: config.url, token: nil, password: nil)
        let url = try identityURL ?? GatewayEndpointStore.dashboardURL(
            for: dashboardConfig, mode: mode, authToken: browserSession == nil ? token : nil)
        try browserSession?.validate(for: url)
        let auth: DashboardWindowAuth = if identityURL != nil || browserSession != nil {
            .browserIdentity(gatewayUrl: Self.websocketURLString(for: url))
        } else {
            DashboardWindowAuth(
                gatewayUrl: Self.websocketURLString(for: url),
                token: token,
                password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        }
        let name = target == .primary ? "OpenClaw"
            : self.gatewayEntries.first { $0.id == target.bridgeID }?.name ?? url.host ?? "Gateway"
        // The public sign-in origin owns normal HTTPS trust; an SSH/native TLS
        // pin and its bearer credentials belong only to the device connection.
        return WindowConfiguration(
            url: url,
            auth: auth,
            tlsParams: identityURL == nil && browserSession == nil ? endpoint.tls?.params : nil,
            mode: mode,
            displayName: name,
            browserSession: browserSession)
    }
}
