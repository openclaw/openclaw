import AppKit
import Foundation
import OpenClawKit
import WebKit

enum DashboardRouteProbePurpose: Sendable {
    case authentication
    case presentation
}

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
        var legacyNativeCredentials: DashboardNativeGatewayAuth.LegacyCredentials?
        var nativeAuthProvider: DashboardNativeGatewayAuth.Provider?
        /// Set for the OpenClaw ID operator proxy: the only store holding its cookie.
        var operatorDataStore: WKWebsiteDataStore?
        /// Blocks cookies on every request but the proxy's own origin, including subframes.
        var operatorCookieRule: WKContentRuleList?
    }

    struct SupersededDashboardPresentation: Error {}

    struct NavigationIntent {
        let id = UUID()
        let windowID: ObjectIdentifier?
    }

    @MainActor
    struct WindowIntent {
        let window: NSWindow?
        private let lifetime: UInt64?
        private let generation: UInt64?

        init(_ controller: DashboardWindowController?) {
            self.window = controller?.window
            self.lifetime = controller?.windowLifetimeRevision
            self.generation = controller?.windowIntentGeneration
        }

        func currentController(for target: DashboardGatewayTarget, in manager: DashboardManager)
            -> DashboardWindowController?
        {
            // A replacement document may inherit the shell; a new selection,
            // close, or experience switch retires the shell's earlier intent.
            guard let controller = self.window?.windowController as? DashboardWindowController,
                  manager.target(for: controller) == target,
                  controller.windowLifetimeRevision == self.lifetime,
                  controller.windowIntentGeneration == self.generation else { return nil }
            return controller
        }
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
        controlUiBasePathProvider: (@Sendable (DashboardGatewayTarget, GatewayConnection.Config) async throws
            -> String?)? = { _, _ in nil },
        legacyCredentialsProvider: (@Sendable (DashboardGatewayTarget, GatewayConnection.EndpointSnapshot) async throws
            -> DashboardNativeGatewayAuth.LegacyCredentials)? = { _, _ in
            .init(credentials: [:], isCurrent: { true }, waitForInvalidation: nil)
        },
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
            controlUiBasePathProvider: controlUiBasePathProvider,
            legacyCredentialsProvider: legacyCredentialsProvider,
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

    func canFocusWithoutReload(_ controller: DashboardWindowController) -> Bool {
        controller.documentHost.hasCurrentBrowserSession && !controller.isShowingFailurePage
    }

    func loadWindow(
        _ controller: DashboardWindowController,
        configuration: WindowConfiguration,
        present: Bool,
        restoringRoute: URL? = nil)
    {
        controller.documentHost.nativeGatewayAuthProvider = configuration.nativeAuthProvider
        controller.documentHost.legacyNativeCredentials = configuration.legacyNativeCredentials
        if let page = configuration.signedOut {
            controller.showSignedOut(page, present: present, autoStart: configuration.autoStartSignIn)
        } else if present {
            controller.show(url: configuration.url, auth: configuration.auth)
        } else {
            controller.update(
                url: configuration.url, auth: configuration.auth, restoringRoute: restoringRoute)
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
            guard error as? GatewayBrowserSessionError == .expired,
                  let endpoint, let session = endpoint.browserSession else { return nil }
            profile = MacGatewayProfile(
                id: profileID, name: name ?? endpoint.config.url.host ?? "Gateway", url: endpoint.config.url)
            expiry = session.expiresAt
        }
        try self.init(
            url: GatewayEndpointStore.dashboardURL(for: (profile.url, nil, nil), mode: .remote),
            auth: .unauthenticated,
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

    func dashboardConfiguration(
        endpoint: GatewayConnection.EndpointSnapshot,
        mode: AppState.ConnectionMode,
        target: DashboardGatewayTarget,
        token: String?) async throws
        -> (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
    {
        var endpoint = endpoint
        let config = endpoint.config
        let browserSession = endpoint.browserSession
        try browserSession?.validate(for: config.url)
        // The OpenClaw ID operator proxy is this Mac's dashboard route; never the claw's
        // browser sign-in origin, which would need a separate browser approval.
        let operatorDashboard = MacOpenClawIDOperatorRoute.dashboardRoute(for: config.url)
        let advertisedIdentityURL = operatorDashboard == nil && (mode == .remote || endpoint.tls != nil)
            ? try await browserIdentityURLProvider(target, config)
            : nil
        let identityURL = mode == .remote ? advertisedIdentityURL : nil
        // The preflight may have replaced a learned leaf pin. Browser TLS and
        // native-auth closures must capture the refreshed endpoint, not the failed pin.
        if let tls = endpoint.tls, tls.allowsTrustedPinReplacement,
           let storeKey = tls.params.storeKey,
           let fingerprint = GatewayTLSStore.loadFingerprint(stableID: storeKey),
           fingerprint != tls.params.expectedFingerprint
        {
            // The pin store owns this one changed fact. Keep the captured route
            // revision/authority; an immediate primary config read has no revision.
            endpoint = GatewayConnection.EndpointSnapshot(
                config: config,
                tls: GatewayTLSRoute(
                    params: GatewayTLSParams(
                        required: tls.params.required,
                        expectedFingerprint: fingerprint,
                        allowTOFU: false,
                        storeKey: storeKey),
                    allowsTrustedPinReplacement: true),
                routeAuthority: endpoint.routeAuthority,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                revision: endpoint.revision,
                browserSession: browserSession)
        }
        // Device grants remain challenge-only. Shared startup credentials retain
        // the released UI contract, but come only from the native accepted binding.
        let dashboardConfig: GatewayConnection.Config = (url: config.url, token: nil, password: nil)
        let remoteBasePath = mode == .remote && identityURL == nil
            ? try await controlUiBasePathProvider(target, config)
            : nil
        let url = try identityURL ?? GatewayEndpointStore.dashboardURL(
            for: dashboardConfig, mode: mode, remoteBasePath: remoteBasePath)
        // Cookies ignore ports, so the proxy cookie lives only in a store that loads nothing else:
        // other loopback servers, the local Gateway and reading tabs never receive it.
        let operatorDataStore = operatorDashboard.map { _ in self.operatorDashboardStore }
        var operatorCookieRule: WKContentRuleList?
        if let operatorDashboard, let operatorDataStore {
            // A frame from another loopback port is still same-site; the rule keeps the cookie
            // on requests to the proxy's exact HTTP and WebSocket origin only.
            operatorCookieRule = try await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "openclaw.ocid-operator-cookie-origin",
                encodedContentRuleList: MacOpenClawIDDashboardProxy.cookieRules(for: operatorDashboard.url))
            await operatorDataStore.httpCookieStore.setCookie(operatorDashboard.cookie)
        }
        try browserSession?.validate(for: url)
        let legacyCredentials: DashboardNativeGatewayAuth.LegacyCredentials? = if identityURL == nil,
                                                                                  browserSession == nil
        {
            try await self.legacyCredentialsProvider(target, endpoint)
        } else {
            nil
        }
        guard legacyCredentials?.isCurrent() != false else { throw CancellationError() }
        let auth: DashboardWindowAuth = if identityURL != nil || browserSession != nil {
            .browserIdentity(gatewayUrl: Self.websocketURLString(for: url))
        } else {
            .nativeDevice(
                gatewayUrl: Self.websocketURLString(for: url),
                token: operatorDashboard == nil ? token : nil,
                password: operatorDashboard == nil
                    ? config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty : nil,
                legacyCredentials: legacyCredentials?.credentials)
        }
        let name = target == .primary ? "OpenClaw"
            : self.gatewayEntries.first { $0.id == target.bridgeID }?.name ?? url.host ?? "Gateway"
        // The public sign-in origin owns normal HTTPS trust; an SSH/native TLS
        // pin and its bearer credentials belong only to the device connection.
        return (WindowConfiguration(
            url: url,
            auth: auth,
            tlsParams: identityURL == nil && browserSession == nil && operatorDashboard == nil
                ? endpoint.tls?.params : nil,
            mode: mode,
            displayName: name,
            browserSession: browserSession,
            legacyNativeCredentials: legacyCredentials,
            nativeAuthProvider: auth.usesNativeDevice ? self
                .nativeAuthProvider(target: target, endpoint: endpoint) : nil,
            operatorDataStore: operatorDataStore,
            operatorCookieRule: operatorCookieRule), endpoint)
    }

    func nativeAuthProvider(
        target: DashboardGatewayTarget,
        endpoint: GatewayConnection.EndpointSnapshot) -> DashboardNativeGatewayAuth.Provider
    {
        let connectionProvider = self.connectionProvider
        return { nonce, signedAt in
            let connection = await connectionProvider(target)
            return try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: nonce, signedAt: signedAt)
        }
    }

    static func requiresIsolatedDashboardDocument(
        _ controller: DashboardWindowController,
        configuration: WindowConfiguration,
        endpoint: GatewayConnection.EndpointSnapshot,
        displayedRoute: (revision: UInt64?, authority: UInt64?)?,
        comparePrimaryRoute: Bool = true) -> Bool
    {
        // A saved renewal may reach the catalog before its serialized cookie
        // write finishes. The existing account lease remains valid throughout.
        controller.documentHost.tlsParams != configuration.tlsParams ||
            !controller.auth.hasSameDocumentIdentity(as: configuration.auth) ||
            !controller.documentHost.hasCurrentBrowserSession ||
            controller.documentHost.browserSession?.browserDataPrincipal != configuration.browserSession?
            .browserDataPrincipal ||
            (comparePrimaryRoute && (endpoint.routeAuthority != displayedRoute?.authority ||
                    endpoint.revision.map { $0 != displayedRoute?.revision } == true))
    }

    func localWindowConfiguration() async throws
        -> (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
    {
        let state = AppStateStore.shared
        guard state.connectionMode == .remote, state.hostsLocalGatewayWithRemotePrimary,
              state.gatewayConfigIsCurrentForRouting else { throw CancellationError() }
        let generation = state.gatewayRoutingGeneration
        let endpoint = try GatewayEndpointStore.localEndpoint(hostingBesideRemotePrimary: true)
        let resolved = try await dashboardConfiguration(
            endpoint: endpoint, mode: .local, target: .local, token: endpoint.config.token)
        guard state.connectionMode == .remote, state.hostsLocalGatewayWithRemotePrimary,
              state.gatewayRoutingGeneration == generation,
              state.gatewayConfigIsCurrentForRouting else { throw CancellationError() }
        return resolved
    }

    func windowConfiguration(
        for target: DashboardGatewayTarget, userGesture: Bool = false) async throws
        -> (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
    {
        switch target {
        case .primary:
            while true {
                try Task.checkCancellation()
                let generation = self.endpointGeneration
                let mode = AppStateStore.shared.connectionMode
                do {
                    let endpoint = try await primaryEndpoint(mode: mode)
                    let config = endpoint.config
                    let token = await authTokenProvider(config)
                    guard self.endpointGeneration == generation else { continue }
                    let resolved = try await dashboardConfiguration(
                        endpoint: endpoint, mode: mode, target: target, token: token)
                    guard self.endpointGeneration == generation else { continue }
                    return resolved
                } catch {
                    guard self.endpointGeneration == generation else { continue }
                    throw error
                }
            }
        case .local:
            return try await self.localWindowConfiguration()
        case let .profile(profileID):
            while true {
                try Task.checkCancellation()
                guard !self.unavailableProfileIDs.contains(profileID) else { throw CancellationError() }
                let revision = self.profileCredentialRevisions[profileID, default: 0]
                var resolvedEndpoint: GatewayConnection.EndpointSnapshot?
                do {
                    let endpoint = try await profileEndpoint(profileID: profileID)
                    resolvedEndpoint = endpoint
                    let resolved = try await dashboardConfiguration(
                        endpoint: endpoint, mode: .remote, target: target, token: endpoint.config.token)
                    guard self.profileCredentialRevisions[profileID, default: 0] == revision else { continue }
                    return resolved
                } catch {
                    guard self.profileCredentialRevisions[profileID, default: 0] == revision else { continue }
                    guard let configuration = try WindowConfiguration(
                        signedOut: error,
                        profileID: profileID,
                        name: self.gatewayEntries.first { $0.id == target.bridgeID }?.name,
                        endpoint: resolvedEndpoint,
                        userGesture: userGesture)
                    else { throw error }
                    return (configuration, GatewayConnection.EndpointSnapshot(
                        config: (configuration.url, nil, nil), routeAuthority: nil))
                }
            }
        }
    }
}
