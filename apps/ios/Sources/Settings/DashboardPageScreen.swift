import OpenClawKit
import SwiftUI

/// Dashboard pages share the Settings hub's authority gate, bridge, and native fallback.
struct DashboardPageScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.userNavigationAction) private var userNavigationAction
    @State private var localNavigationPath: [SettingsRoute] = []
    let path: String
    let title: String
    var navigationPath: Binding<[SettingsRoute]>?
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var onClose: (() -> Void)?
    var onRouteChange: ((SettingsRoute?) -> Void)?
    var onApprovalNotificationsRoute: ((String?) -> Void)?

    var body: some View {
        NavigationStack(path: self.userNavigationPath) {
            self.root
                .toolbar {
                    if let onClose {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button(action: onClose) {
                                Text("Done")
                                    .font(OpenClawType.subheadSemiBold)
                            }
                            .accessibilityIdentifier("DashboardPage.Close")
                        }
                    }
                }
                .navigationDestination(for: SettingsRoute.self) { route in
                    SettingsProTab(
                        directRoute: route,
                        registersNavigationDestinations: false,
                        onApprovalNotificationsRoute: self.onApprovalNotificationsRoute)
                }
        }
        .onChange(of: self.userNavigationPath.wrappedValue) { _, path in
            self.onRouteChange?(path.last)
        }
    }

    private var userNavigationPath: Binding<[SettingsRoute]> {
        // A hosted Root supplies its already-guarded canonical path. Standalone
        // dashboard sheets keep their own path and the same navigation admission.
        if let navigationPath { return navigationPath }
        let action = self.userNavigationAction
        return Binding(get: { self.localNavigationPath }, set: { path in
            guard path != self.localNavigationPath, action?() ?? true else { return }
            self.localNavigationPath = path
        })
    }

    @ViewBuilder private var root: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let navigationPath = self.userNavigationPath
        if SettingsHubScreen.usesDashboard(
            isOperatorConnected: self.appModel.isOperatorGatewayConnected,
            hasOperatorAdminScope: self.appModel.hasOperatorAdminScope,
            isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
            isScreenshotMode: ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode")),
            let url = AuthenticatedControlUI.pageURL(config: config, path: self.path, queryItems: [])
        {
            EmbeddedDashboardContent(
                appModel: self.appModel,
                appearanceModel: self.appearanceModel,
                gatewayController: self.gatewayController,
                url: url,
                config: config,
                openPanel: { panel in
                    if let route = SettingsHubScreen.route(for: panel) {
                        navigationPath.wrappedValue.append(route)
                    }
                })
                .navigationTitle(self.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let headerSidebarAction {
                        OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
                    }
                }
        } else {
            SettingsProTab(
                registersNavigationDestinations: false,
                headerSidebarAction: self.headerSidebarAction,
                onApprovalNotificationsRoute: self.onApprovalNotificationsRoute)
        }
    }
}
