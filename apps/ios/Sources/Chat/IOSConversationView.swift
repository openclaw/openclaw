import OpenClawKit
import SwiftUI

/// Uses the same web transcript, activity summaries and working indicator as Mac.
struct IOSConversationView: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var controller: IOSConversationController

    var body: some View {
        ZStack {
            if let url = self.controller.documentURL, let bridge = self.controller.bridge {
                self.authenticatedPage(url: url, bridge: bridge)
                    .opacity(bridge.ready ? 1 : 0)
            }
            if self.controller.bridge?.ready != true { ProgressView() }
        }
        .onAppear { self.controller.present(visible: true, active: self.scenePhase == .active) }
        .onDisappear { self.controller.present(visible: false, active: false) }
        .onChange(of: self.scenePhase) { _, phase in
            self.controller.present(visible: true, active: phase == .active)
        }
        .sheet(isPresented: Binding(
            get: { self.controller.dashboardRoute != nil },
            set: { if !$0 { self.controller.dashboardRoute = nil } }))
        {
            if let route = self.controller.dashboardRoute,
               let url = Self.dashboardURL(route, config: self.controller.config)
            {
                NavigationStack {
                    self.authenticatedPage(url: url, bridge: nil)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button { self.controller.dashboardRoute = nil } label: {
                                    Text("Done").font(OpenClawType.subheadSemiBold)
                                }
                            }
                        }
                }
            }
        }
    }

    private func authenticatedPage(url: URL, bridge: IOSConversationBridge?) -> some View {
        let config = self.controller.config
        let authorization = config.ingressAuthorization
        let provider = IOSDashboardNativeGatewayAuthProvider(appModel: self.appModel, config: config)
        let admission = AuthenticatedControlUI.dashboardAccessCookieAdmission(
            url: url,
            requiresCookie: authorization != nil,
            cookieForURL: { authorization?.dashboardCookie($0) })
        let authScript: String?
        let scriptProvider: (@MainActor () async -> String?)?
        if authorization != nil {
            authScript = AuthenticatedControlUI.authUserScript(
                config: config,
                pageURL: url,
                usesNativeNavigationChrome: true)
            scriptProvider = {
                let credentials = await provider?.legacyCredentials()
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
                storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config),
                usesNativeNavigationChrome: true)
            scriptProvider = nil
        }
        return Group {
            if admission.isAvailable {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: authScript,
                    tls: config.tls,
                    authScriptProvider: scriptProvider,
                    nativeGatewayAuthProvider: provider,
                    basicProxyCredentialProvider: { AuthenticatedControlUI.basicProxyCredential(config: config) },
                    conversation: bridge,
                    usesNativeEmbed: true,
                    conversationDataStore: bridge == nil ? nil : self.controller.dataStore,
                    accessCookie: admission.cookie,
                    accessAdmissionIsCurrent: authorization?.isCurrent,
                    accessResponseCheck: authorization?.checkResponse,
                    onAccessCookieBoundaryFailure: { bridge?.onFailure?() })
                    .id(url)
            } else {
                Color.clear.task { bridge?.onFailure?() }
            }
        }
    }

    static func dashboardURL(_ route: NativeConversationDashboardRoute, config: GatewayConnectConfig) -> URL? {
        guard let baseURL = AuthenticatedControlUI.pageURL(config: config, path: "", queryItems: [])
        else { return nil }
        return self.dashboardURL(route, baseURL: baseURL)
    }

    static func dashboardURL(_ route: NativeConversationDashboardRoute, baseURL: URL) -> URL? {
        guard DashboardRouteMap.isValidSameAppPath(route.path),
              route.search.map(DashboardRouteMap.isValidSameAppSearch) != false,
              let path = URLComponents(string: route.path, encodingInvalidCharacters: false)?.percentEncodedPath,
              let decoded = path.removingPercentEncoding, !decoded.contains("\\"),
              !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else { return nil }
        let mount = components.percentEncodedPath.hasSuffix("/")
            ? components.percentEncodedPath : components.percentEncodedPath + "/"
        guard path.hasPrefix(mount) else { return nil }
        components.percentEncodedPath = path
        components.percentEncodedQuery = route.search.map { String($0.dropFirst()) }
        components.fragment = nil
        return components.url
    }
}
