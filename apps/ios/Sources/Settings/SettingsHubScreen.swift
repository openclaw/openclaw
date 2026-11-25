import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit

struct SettingsHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage("screen.preventSleep") private var preventSleep = true
    @State private var showApprovalNotificationSettings = false
    @State private var embedCompatibility = DashboardEmbedCompatibility()
    @State private var account = SettingsAccount.cached
    @Binding var navigationPath: [SettingsRoute]
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var onRouteChange: ((SettingsRoute?) -> Void)?
    var onClose: (() -> Void)?
    var onSelectPage: ((RootTabs.SidebarDestination) -> Void)?
    var onTrySkill: ((String) -> Void)?
    /// Preset search text for the Skills or Plugins screen when search opens one for a named item.
    var toolQuery = ""
    var gatewaySetupRequest: GatewaySetupRequest?
    var onGatewaySetupRequestHandled: ((Int) -> Void)?

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            self.root
                .background(SidebarNavigationMarginAnchor())
                .navigationDestination(for: SettingsRoute.self) { route in
                    self.destination(route)
                }
        }
        .preferredColorScheme(self.appearanceModel.preference.colorScheme)
        .tint(.primary)
        .sheet(isPresented: self.$showApprovalNotificationSettings) {
            DashboardPageScreen(
                path: RootTabs.notificationSettingsPath(
                    servingEnabled: NotificationServingPreference.isEnabled(),
                    disclosureAccepted: !PushBuildConfig.current.usesOpenClawHostedRelay
                        || PushEnrollmentConsent.disclosureAccepted),
                title: String(localized: "Notifications"),
                onClose: { self.showApprovalNotificationSettings = false })
        }
        .onChange(of: self.navigationPath, initial: true) { _, path in
            self.onRouteChange?(path.last)
        }
    }

    private var root: some View {
        List {
            if let account = self.visibleAccount {
                Section { SettingsAccountHeader(account: account) }
            }

            Section {
                self.gatewayRow
                if self.appModel.pendingExecApprovalCount > 0 {
                    NavigationLink(value: SettingsRoute.approvals) {
                        HStack {
                            self.label("Approvals", icon: "checkmark.circle")
                            Spacer()
                            SettingsValueText(.verbatim(self.appModel.pendingExecApprovalCount.formatted()))
                        }
                    }
                    .accessibilityIdentifier("SettingsHub.Approvals")
                }
                self.link("Advanced", icon: "slider.horizontal.3", route: .advanced)
            } header: {
                SettingsSectionTitle("OpenClaw")
            }

            Section {
                self.appearance
                NativeNotificationSettingsRow()
                self.link("Voice & Talk", icon: "mic", route: .voiceAndTalk)
                self.link("Permissions", icon: "checkmark.shield", route: .permissions)
                self.link("Accessories", icon: "applewatch", route: .accessories)
                Toggle(isOn: self.$preventSleep) {
                    self.label("Keep screen awake", icon: "display")
                }
                .tint(OpenClawBrand.ok)
                .accessibilityIdentifier("SettingsHub.KeepAwake")
                self.link("Storage", icon: "internaldrive", route: .storage)
                    .accessibilityIdentifier("SettingsHub.Storage")
            } header: {
                SettingsSectionTitle(UIDevice.current.userInterfaceIdiom == .pad ? "This iPad" : "This iPhone")
            }

            Section {
                self.link("Skills", icon: "book", route: .skills)
                self.link("Plugins", icon: "shippingbox", route: .plugins)
            } header: {
                SettingsSectionTitle("Tools")
            }

            Section {
                NativePersonalSettingsRow(agentID: self.agentID, agentName: self.appModel.chatAgentName)
                self.link("Chat", icon: "bubble.left", route: .chatPreferences)
                self.link("Sidebar", icon: "sidebar.left", route: .sidebarPages)
                self.link("About", icon: "info.circle", route: .about)
            } header: {
                SettingsSectionTitle("App")
            }
        }
        .listStyle(.insetGrouped)
        .task(id: self.accountRequest) { await self.refreshAccount(self.accountRequest) }
        .accessibilityIdentifier("SettingsHub.Native")
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
            }
            if let onClose {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { onClose() }
                        .accessibilityIdentifier("SettingsHub.Close")
                }
            }
        }
    }

    private var agentID: String {
        self.appModel.chatAgentId.trimmedNonEmpty ?? "main"
    }

    private var accountRequest: SettingsAccount.Request {
        SettingsAccount.Request(
            ownerID: self.appModel.chatViewModelOwnerID,
            authorityGeneration: self.appModel.operatorAuthorityGeneration,
            isConnected: self.appModel.isOperatorGatewayConnected && !self.appModel.isLocalGatewayFixtureEnabled)
    }

    private var visibleAccount: SettingsAccount? {
        guard let account, account.request == self.accountRequest, account.request.isConnected else { return nil }
        return account
    }

    /// Identity is scoped to the admitted operator connection, including same-host account changes.
    private func refreshAccount(_ request: SettingsAccount.Request) async {
        guard request.isConnected, request == self.accountRequest, !Task.isCancelled else { return }
        let gateway = self.appModel.operatorSession
        guard let route = await gateway.currentRoute(),
              let data = try? await gateway.request(method: "users.self", params: [:], ifCurrentRoute: route),
              !Task.isCancelled,
              await gateway.currentRoute() == route,
              request == self.accountRequest
        else { return }
        let account = SettingsAccount(request: request, selfProfile: data)
        self.account = account
        SettingsAccount.cached = account
    }

    /// The connection row names the host and stays quiet while everything works; only an
    /// exception (offline, limited access) shows as its value.
    private var gatewayRow: some View {
        NavigationLink(value: SettingsRoute.gateway) {
            HStack {
                Label {
                    Group {
                        if let name = self.appModel.gatewayServerName?.trimmedNonEmpty {
                            Text(verbatim: name)
                        } else {
                            Text("Connection")
                        }
                    }
                    .font(SettingsType.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
                } icon: {
                    NativeSettingsRowIcon(systemName: "dot.radiowaves.left.and.right")
                }
                if let exception = self.gatewayException {
                    Spacer(minLength: 8)
                    SettingsValueText(.verbatim(exception))
                }
            }
        }
        .accessibilityIdentifier("SettingsHub.Gateway")
    }

    private var gatewayException: String? {
        if !self.appModel.isOperatorGatewayConnected {
            return String(localized: "Offline")
        }
        if !self.appModel.hasOperatorAdminScope {
            return String(localized: "Limited access")
        }
        return nil
    }

    private var appearance: some View {
        Picker(selection: Binding(
            get: { self.appearanceModel.preference },
            set: { self.appearanceModel.select($0) }))
        {
            Text("System").font(OpenClawType.body).tag(AppAppearancePreference.system)
            Text("Light").font(OpenClawType.body).tag(AppAppearancePreference.light)
            Text("Dark").font(OpenClawType.body).tag(AppAppearancePreference.dark)
        } label: {
            self.label("Appearance", icon: "sun.max")
        }
        .settingsMenuPicker()
        .accessibilityIdentifier("SettingsHub.Appearance")
    }

    private func label(_ title: LocalizedStringKey, icon: String) -> some View {
        Label {
            Text(title).font(SettingsType.label)
        } icon: {
            NativeSettingsRowIcon(systemName: icon)
        }
    }

    private func link(_ title: LocalizedStringKey, icon: String, route: SettingsRoute) -> some View {
        NavigationLink(value: route) { self.label(title, icon: icon) }
    }

    @ViewBuilder
    private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .voiceAndTalk:
            LocalDeviceSettingsScreen(layout: .voiceAndTalk)
                .navigationTitle("Voice & Talk")
                .navigationBarTitleDisplayMode(.inline)
        case .permissions:
            LocalDeviceSettingsScreen(layout: .permissions)
                .navigationTitle("Permissions")
                .navigationBarTitleDisplayMode(.inline)
        case .accessories:
            // Icons mark the Settings root only; pages below it are plain rows.
            List {
                NavigationLink(value: SettingsRoute.appleWatch) {
                    Text("Apple Watch").font(SettingsType.label)
                }
                .accessibilityIdentifier("settings-watch-row")
                NavigationLink(value: SettingsRoute.espSetup) {
                    Text("ESP device setup").font(SettingsType.label)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Accessories")
            .navigationBarTitleDisplayMode(.inline)
        case .chatPreferences:
            NativeChatSettingsScreen()
        case .storage:
            NativeStorageSettingsScreen()
        case .sidebarPages:
            RootSidebarPagesEditor(onSelect: { self.onSelectPage?($0) }, presentedAsSheet: false)
        case .skills, .plugins:
            NativeToolSettingsScreen(
                kind: route == .skills ? .skills : .plugins,
                agentID: self.agentID,
                agentName: self.appModel.chatAgentName,
                gatewayName: self.appModel.gatewayServerName,
                initialQuery: self.toolQuery,
                onTrySkill: self.onTrySkill)
        case .advanced:
            self.advanced
        default:
            SettingsProTab(
                directRoute: route,
                registersNavigationDestinations: false,
                acceptsGatewaySetupRequests: route == .gateway,
                onApprovalNotificationsRoute: { _ in self.showApprovalNotificationSettings = true },
                gatewaySetupRequest: self.gatewaySetupRequest,
                onGatewaySetupRequestHandled: self.onGatewaySetupRequestHandled)
        }
    }

    private var advanced: some View {
        Group {
            let config = self.appModel.activeGatewayConnectConfig
            if Self.usesDashboard(
                isOperatorConnected: self.appModel.isOperatorGatewayConnected,
                hasOperatorAdminScope: self.appModel.hasOperatorAdminScope,
                isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
                isScreenshotMode: ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode")),
                let url = AuthenticatedControlUI.pageURL(
                    config: config,
                    path: DashboardRouteMap.settingsPath,
                    queryItems: [])
            {
                EmbeddedDashboardContent(
                    appModel: self.appModel,
                    appearanceModel: self.appearanceModel,
                    gatewayController: self.gatewayController,
                    url: url,
                    config: config,
                    openPanel: { panel in
                        if let route = Self.route(for: panel) {
                            self.navigationPath.append(route)
                        }
                    },
                    embedCompatibility: self.embedCompatibility,
                    openGateway: { self.navigationPath.append(.gateway) })
            } else {
                List {
                    Section {
                        self.gatewayRow
                    } footer: {
                        if self.appModel.isOperatorGatewayConnected, !self.appModel.hasOperatorAdminScope {
                            SettingsFootnote("Advanced settings require full access.")
                        }
                    }
                }
            }
        }
        .navigationTitle("Advanced")
        .navigationBarTitleDisplayMode(.inline)
    }

    static func usesDashboard(
        isOperatorConnected: Bool,
        hasOperatorAdminScope: Bool,
        isDemoMode: Bool,
        isScreenshotMode: Bool) -> Bool
    {
        isOperatorConnected && hasOperatorAdminScope && !isDemoMode && !isScreenshotMode
    }

    static func route(for panel: DeviceSettingsPanel) -> SettingsRoute? {
        switch panel {
        case .connection, .gateways: .gateway
        case .watch: .appleWatch
        case .diagnostics: .diagnostics
        case .licenses: .licenses
        case .about: .about
        case .aiSetup, .quickChatShortcut, .microphoneTest, .browserImport, .debug: nil
        }
    }
}

struct EmbeddedDashboardContent: View {
    @State private var bridge: IOSDeviceSettingsBridge
    @State private var failedAccessBoundaryIdentity: Int?
    private let appModel: NodeAppModel
    let embedCompatibility: DashboardEmbedCompatibility?
    let url: URL
    let config: GatewayConnectConfig?
    let openGateway: (() -> Void)?

    init(
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        gatewayController: GatewayConnectionController,
        url: URL,
        config: GatewayConnectConfig?,
        openPanel: @escaping (DeviceSettingsPanel) -> Void,
        embedCompatibility: DashboardEmbedCompatibility? = nil,
        openGateway: (() -> Void)? = nil)
    {
        self.appModel = appModel
        self.url = url
        self.config = config
        self.openGateway = openGateway
        self.embedCompatibility = embedCompatibility
        self._bridge = State(initialValue: IOSDeviceSettingsBridge(
            appModel: appModel,
            appearanceModel: appearanceModel,
            gatewayController: gatewayController,
            openPanel: openPanel,
            onStatusRequest: { [weak embedCompatibility] in
                embedCompatibility?.didReceiveStatusRequest()
            }))
    }

    var body: some View {
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: self.config)
        let authorization = self.config?.ingressAuthorization
        let webContentIdentity = AuthenticatedControlUI.webContentIdentity(
            config: self.config,
            storedOperatorToken: storedOperatorToken,
            authorizationRevision: authorization?.revision)
        Group {
            if let httpErrorStatus = self.embedCompatibility?.httpErrorStatus {
                self.httpErrorView(statusCode: httpErrorStatus)
            } else {
                VStack(spacing: 0) {
                    self.gatewayUpgradeBanner
                    self.ingressSignInGuidance
                    if let authorization {
                        if let cookie = authorization.dashboardCookie(self.url) {
                            if self.failedAccessBoundaryIdentity == webContentIdentity {
                                self.accessUnavailable
                            } else {
                                self.dashboardWebView(
                                    accessCookie: cookie,
                                    authorization: authorization,
                                    webContentIdentity: webContentIdentity,
                                    onAccessCookieBoundaryFailure: {
                                        self.failedAccessBoundaryIdentity = webContentIdentity
                                    })
                            }
                        } else {
                            self.accessUnavailable
                        }
                    } else {
                        self.dashboardWebView(
                            accessCookie: nil,
                            authorization: nil,
                            webContentIdentity: webContentIdentity)
                    }
                }
            }
        }
        // The error page has no web view for `.id` to recreate, and the error outlives this view while
        // a Gateway switch reconnects. Each new view or identity loads once, as the web view did.
        .onChange(of: webContentIdentity, initial: true) { _, _ in
            self.embedCompatibility?.reload()
        }
    }

    @MainActor
    private func dashboardWebView(
        accessCookie: HTTPCookie?,
        authorization: GatewayIngressAuthorization?,
        webContentIdentity: Int,
        onAccessCookieBoundaryFailure: (@MainActor () -> Void)? = nil) -> some View
    {
        let config = self.config
        let url = self.url
        let nativeAuthProvider = IOSDashboardNativeGatewayAuthProvider(appModel: self.appModel, config: self.config)
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        let authScript: String?
        let authScriptProvider: (@MainActor () async -> String?)?
        if authorization != nil {
            authScript = AuthenticatedControlUI.authUserScript(
                config: config,
                pageURL: url,
                usesNativeNavigationChrome: true)
            authScriptProvider = {
                let credentials = await nativeAuthProvider?.legacyCredentials()
                return AuthenticatedControlUI.authUserScript(
                    config: config,
                    pageURL: url,
                    legacyCredentials: credentials,
                    usesNativeNavigationChrome: true)
            }
        } else {
            authScript = AuthenticatedControlUI.authUserScript(
                config: config,
                pageURL: url,
                storedOperatorToken: storedOperatorToken,
                usesNativeNavigationChrome: true)
            authScriptProvider = nil
        }
        return AuthenticatedControlUIWebView(
            url: url,
            authScript: authScript,
            tls: config?.tls,
            authScriptProvider: authScriptProvider,
            nativeGatewayAuthProvider: nativeAuthProvider,
            basicProxyCredentialProvider: {
                AuthenticatedControlUI.basicProxyCredential(config: config)
            },
            deviceSettingsBridge: self.bridge,
            usesNativeEmbed: true,
            embedCompatibility: self.embedCompatibility,
            accessCookie: accessCookie,
            accessAdmissionIsCurrent: authorization?.isCurrent,
            accessResponseCheck: authorization?.checkResponse,
            onAccessCookieBoundaryFailure: onAccessCookieBoundaryFailure)
            .id(webContentIdentity)
            .accessibilityIdentifier("SettingsHub.Dashboard")
    }

    private var accessUnavailable: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(
                "The web app is unavailable with this Cloudflare session. Native chat and settings still work.")
                .font(OpenClawType.body)
            if let openGateway {
                Button(action: openGateway) {
                    Text("Open Gateway settings")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
        }
        .padding()
        .accessibilityIdentifier("SettingsHub.AccessUnavailable")
    }

    @ViewBuilder private var ingressSignInGuidance: some View {
        if self.config?.ingressAuthorization != nil {
            VStack(alignment: .leading, spacing: 8) {
                Text(
                    "This page requires a Gateway web app that supports native app sign-in. " +
                        "If it can’t connect, update the Gateway. " +
                        "Native chat and settings remain available.")
                    .font(OpenClawType.footnote)
                    .accessibilityIdentifier("SettingsHub.NativeSignInGuidance")
                if let openGateway {
                    Button(action: openGateway) {
                        Text("Open Gateway settings")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityIdentifier("SettingsHub.NativeSignInGuidance.OpenGateway")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(OpenClawBrand.warn.opacity(0.12))
        }
    }

    /// Replaces the web view so a Gateway error body never renders raw or reads as an outdated Dashboard;
    /// Reload recreates the web view for a fresh load.
    private func httpErrorView(statusCode: Int) -> some View {
        let message = String(
            format: String(localized: "The Gateway returned HTTP %ld (%@)."),
            statusCode,
            HTTPURLResponse.localizedString(forStatusCode: statusCode).capitalized)
        return VStack(spacing: 12) {
            Text("Web app unavailable")
                .font(OpenClawType.subheadSemiBold)
            Text(message)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                self.embedCompatibility?.reload()
            } label: {
                Text("Try again")
                    .font(OpenClawType.subheadSemiBold)
            }
            .openClawProminentButton()
            .accessibilityIdentifier("SettingsHub.DashboardReload")
            if let openGateway {
                Button(action: openGateway) {
                    Text("Open Gateway settings")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("SettingsHub.DashboardError")
    }

    @ViewBuilder private var gatewayUpgradeBanner: some View {
        if let openGateway, self.embedCompatibility?.needsGatewayUpgrade == true {
            VStack(alignment: .leading, spacing: 8) {
                Text("This Gateway’s web app is older than this app. Update the Gateway to manage settings here.")
                    .font(OpenClawType.footnote)
                    .accessibilityIdentifier("SettingsHub.GatewayUpgradeWarning")
                Button(action: openGateway) {
                    Text("Open Gateway settings")
                        .font(OpenClawType.subheadSemiBold)
                }
                .accessibilityIdentifier("SettingsHub.UpgradeGateway")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(OpenClawBrand.warn.opacity(0.12))
        }
    }
}

private struct NativeStorageSettingsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var usage: OpenClawClientDatabases.GatewayCacheUsage?
    @State private var updating = false
    @State private var confirmsClear = false
    @State private var failure: LocalizedStringKey?

    var body: some View {
        List {
            if let usage {
                Section {
                    SettingsDetailRow(
                        "Cache size",
                        value: .verbatim(ByteCountFormatter.string(fromByteCount: usage.bytes, countStyle: .file)))
                    SettingsDetailRow("Cached conversations", value: .verbatim(usage.conversations.formatted()))
                } header: {
                    SettingsSectionTitle("Chat cache")
                }
                Section {
                    Button(role: .destructive) {
                        self.confirmsClear = true
                    } label: {
                        Text("Clear Cache").font(SettingsType.label)
                    }
                    .disabled(self.updating || !usage.hasCachedData)
                    .accessibilityIdentifier("Storage.ClearCache")
                }
            }
            if let failure {
                Section {
                    Text(failure).font(SettingsType.label).foregroundStyle(SettingsInk.secondary)
                    if self.usage == nil {
                        Button { Task { await self.update() } } label: {
                            Text("Try again").font(OpenClawType.body)
                        }
                    }
                }
            }
            if self.updating || (self.usage == nil && self.failure == nil) {
                ProgressView()
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Storage")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("Storage.Native")
        .task { await self.update() }
        .alert("Clear cache?", isPresented: self.$confirmsClear) {
            Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.body) }
            Button(role: .destructive) { Task { await self.update(clearing: true) } } label: {
                Text("Clear Cache").font(OpenClawType.body)
            }
        } message: {
            // Names the device the way the root's section title does.
            if UIDevice.current.userInterfaceIdiom == .pad {
                Text("Removes saved copies of chats from this iPad.").font(OpenClawType.body)
            } else {
                Text("Removes saved copies of chats from this iPhone.").font(OpenClawType.body)
            }
        }
    }

    private func update(clearing: Bool = false) async {
        guard !self.updating else { return }
        self.updating = true
        self.failure = nil
        defer { self.updating = false }
        do {
            self.usage = if clearing {
                try await self.appModel.clearLocalChatCache()
            } else {
                try await self.appModel.localChatCacheUsage()
            }
        } catch {
            self.failure = clearing ? "Couldn’t clear the cache." : "Couldn’t read storage."
        }
    }
}

/// The signed-in person as `users.self` reports them: the name the Control UI profile shows
/// (display name, else GitHub login, else email) and the email as the one secondary line.
struct SettingsAccount: Equatable {
    struct Request: Equatable {
        let ownerID: String
        let authorityGeneration: UInt64
        let isConnected: Bool
    }

    private struct SelfProfile: Decodable {
        struct Profile: Decodable {
            struct GitHubIdentity: Decodable {
                let login: String
            }

            let displayName: String?
            let emails: [String]?
            let githubIdentity: GitHubIdentity?
        }

        let profile: Profile
    }

    /// Last profile read for a request, so reopening Settings does not shift the list when it lands.
    @MainActor static var cached: SettingsAccount?

    let request: Request
    let name: String
    let detail: String?

    init?(request: Request, selfProfile data: Data) {
        guard let profile = try? JSONDecoder().decode(SelfProfile.self, from: data).profile else { return nil }
        let email = profile.emails?.lazy.compactMap(\.trimmedNonEmpty).first
        guard let name = profile.displayName?.trimmedNonEmpty ?? profile.githubIdentity?.login.trimmedNonEmpty ?? email
        else { return nil }
        self.request = request
        self.name = name
        self.detail = email == name ? nil : email
    }

    var initials: String {
        self.name.split(whereSeparator: \.isWhitespace)
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }
}

/// Account header in the place of the iOS Settings account row. There is no profile screen to
/// open on iPhone yet, so it is a plain header: no chevron, no tap.
private struct SettingsAccountHeader: View {
    let account: SettingsAccount
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .title2) private var avatarSize = 60.0

    var body: some View {
        let layout = self.dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(spacing: 14))
        layout {
            Text(verbatim: self.account.initials)
                .font(OpenClawType.avatar(size: 24))
                .foregroundStyle(.white)
                .frame(width: self.avatarSize, height: self.avatarSize)
                .background(Color(uiColor: .systemGray).gradient, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: self.account.name)
                    .font(OpenClawType.title3SemiBold)
                    .foregroundStyle(.primary)
                if let detail = self.account.detail {
                    Text(verbatim: detail)
                        .font(SettingsType.description)
                        .foregroundStyle(SettingsInk.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("SettingsHub.Account")
    }
}
