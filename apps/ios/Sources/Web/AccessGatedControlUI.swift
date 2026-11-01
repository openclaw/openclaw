import SwiftUI

/// Every Control UI WebView host (Dashboard pages, Desktop, Terminal, session Dashboard) goes through this
/// gate, so an Access-managed Gateway gets the same seeded browser session or the same native fallback.
struct AccessGatedControlUI<Content: View>: View {
    typealias SignInHandler = (CloudflareAccessWebFallbackReason) -> Void

    /// Resolved per WebView identity outside `body`: reading the Access store can expire a grant.
    @State private var accessDecision: (identity: Int, decision: CloudflareAccessWebSession.Decision)?
    @State private var accessFallback: (identity: Int, reason: CloudflareAccessWebFallbackReason)?
    @State private var accessAttempt = 0
    private let gatewayController: GatewayConnectionController
    private let config: GatewayConnectConfig?
    private let url: URL
    private let identity: Int
    private let openGateway: (() -> Void)?
    private let content: (CloudflareAccessWebCookie?, @escaping SignInHandler) -> Content

    init(
        gatewayController: GatewayConnectionController,
        config: GatewayConnectConfig?,
        url: URL,
        identity: Int,
        openGateway: (() -> Void)?,
        @ViewBuilder content: @escaping (CloudflareAccessWebCookie?, @escaping SignInHandler) -> Content)
    {
        self.gatewayController = gatewayController
        self.config = config
        self.url = url
        self.identity = identity
        self.openGateway = openGateway
        self.content = content
    }

    var body: some View {
        Group {
            if self.config?.ingressAuthorization == nil {
                self.content(nil) { _ in }
            } else if let fallback = self.accessFallback, fallback.identity == self.identity {
                self.fallbackView(reason: fallback.reason)
            } else if let resolved = self.accessDecision, resolved.identity == self.identity {
                switch resolved.decision {
                case .ordinary:
                    self.content(nil) { _ in }
                case let .seed(cookie):
                    self.content(cookie) { reason in self.accessFallback = (self.identity, reason) }
                case .signInRequired:
                    self.fallbackView(reason: .signInRequired)
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: [self.identity, self.accessAttempt]) {
            guard self.config?.ingressAuthorization != nil else { return }
            self.accessDecision = (self.identity, self.gatewayController.ingress.webSessionDecision(
                authorization: self.config?.ingressAuthorization,
                pageURL: self.url))
        }
    }

    private func fallbackView(reason: CloudflareAccessWebFallbackReason) -> some View {
        DashboardAccessSignInFallback(
            reason: reason,
            openGateway: self.openGateway,
            retry: {
                // Re-read the grant and rebuild the WebView; the fallback replaced it, so this is a fresh load.
                self.accessFallback = nil
                self.accessDecision = nil
                self.accessAttempt += 1
            })
    }
}
