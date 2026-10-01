import OpenClawKit
import SwiftUI

enum ControlUIHubPage {
    case desktop(source: String?, session: String?)
    case terminal

    var title: Text {
        switch self {
        case .desktop: Text("Desktop")
        case .terminal: Text("Terminal")
        }
    }

    var symbol: String {
        switch self {
        case .desktop: "display"
        case .terminal: "terminal"
        }
    }

    var unavailableTitle: Text {
        switch self {
        case .desktop: Text("Desktop needs a connected gateway")
        case .terminal: Text("Terminal needs a connected gateway")
        }
    }

    var unavailableDetail: Text {
        switch self {
        case .desktop: Text("Connect to your gateway to view an observable machine.")
        case .terminal: Text("Connect to your gateway to open a shell in the agent workspace.")
        }
    }

    func url(config: GatewayConnectConfig?) -> URL? {
        guard let path = self.path else { return nil }
        return AuthenticatedControlUI.pageURL(config: config, path: path, queryItems: [])
    }

    func authUserScript(config: GatewayConnectConfig?, storedOperatorToken: String?) -> String? {
        AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: self.url(config: config),
            storedOperatorToken: storedOperatorToken)
    }

    func webContentIdentity(config: GatewayConnectConfig?, storedOperatorToken: String?) -> Int {
        let identity = AuthenticatedControlUI.webContentIdentity(
            config: config,
            storedOperatorToken: storedOperatorToken)
        guard case .desktop = self else { return identity }
        var hasher = Hasher()
        hasher.combine(identity)
        hasher.combine(self.path)
        return hasher.finalize()
    }

    private var path: String? {
        switch self {
        case .terminal:
            return "/focus/terminal"
        case let .desktop(source, session):
            for (kind, value) in [("source", source), ("session", session)] {
                let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !trimmed.isEmpty else { continue }
                guard let encoded = AuthenticatedControlUI.percentEncodedPathSegment(trimmed) else { return nil }
                return "/focus/desktop/\(kind)/\(encoded)"
            }
            return "/focus/desktop"
        }
    }
}

/// Authenticated, origin-locked Desktop and Terminal pages share native chrome
/// and the offline fallback; the page owns its route and reload identity.
struct ControlUIHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let page: ControlUIHubPage
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var usesNativeNavigationChrome = false
    var gatewayAction: (() -> Void)?

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = self.page.url(config: config) {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: self.page.authUserScript(config: config, storedOperatorToken: storedOperatorToken),
                    tls: config?.tls)
                    // Unrelated SwiftUI updates must not reload a live desktop or shell.
                        .id(self.page.webContentIdentity(config: config, storedOperatorToken: storedOperatorToken))
                        .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle(self.page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(
            self.usesNativeNavigationChrome || self.headerSidebarAction != nil ? .visible : .hidden,
            for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
            }
        }
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: self.page.symbol, color: OpenClawBrand.accent)
            self.page.unavailableTitle
                .font(OpenClawType.subheadSemiBold)
            self.page.unavailableDetail
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let gatewayAction {
                Button(action: gatewayAction) {
                    Text("Open Gateway Settings")
                        .font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(.borderedProminent)
                .tint(OpenClawBrand.accent)
            }
        }
        .padding(24)
    }
}
