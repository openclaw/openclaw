import CoreFoundation
import Foundation
import OpenClawKit
import WebKit

struct IOSDashboardNativeGatewayAuthRequest {
    let id: String
    let nonce: String
    let signedAt: Int64

    init?(_ body: Any) {
        guard let value = body as? [String: Any],
              Set(value.keys) == ["id", "nonce", "signedAt"],
              let id = value["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
              let nonce = value["nonce"] as? String,
              nonce.utf8.count <= 512, !nonce.contains("|"),
              nonce.unicodeScalars.contains(where: {
                  !CharacterSet.whitespacesAndNewlines.contains($0) &&
                      !CharacterSet.controlCharacters.contains($0) && $0.value != 0xFEFF
              }),
              let timestamp = value["signedAt"] as? NSNumber,
              CFGetTypeID(timestamp) != CFBooleanGetTypeID(),
              timestamp.doubleValue.isFinite,
              timestamp.doubleValue.rounded() == timestamp.doubleValue,
              timestamp.doubleValue > 0, timestamp.doubleValue <= 9_007_199_254_740_991
        else { return nil }
        self.id = id
        self.nonce = nonce
        self.signedAt = timestamp.int64Value
    }
}

@MainActor
struct IOSDashboardNativeGatewayAuthReply {
    let json: Data
    let isCurrent: @MainActor () async -> Bool
}

/// Adapts the live operator session to the Dashboard challenge contract.
/// Credentials remain owned by GatewayNodeSession/GatewayChannelActor.
@MainActor
final class IOSDashboardNativeGatewayAuthProvider {
    private weak var appModel: NodeAppModel?
    private let session: GatewayNodeSession
    private let config: GatewayConnectConfig
    private let authorityGeneration: UInt64
    private let accessPrincipal: CloudflareAccessPrincipal?

    init?(appModel: NodeAppModel, config: GatewayConnectConfig?) {
        guard let config else { return nil }
        self.appModel = appModel
        self.session = appModel.operatorSession
        self.config = config
        self.authorityGeneration = appModel.operatorAuthorityGeneration
        self.accessPrincipal = config.ingressAuthorization?.principal
    }

    func legacyCredentials() async -> [String: String]? {
        guard self.isCurrent(),
              let route = await self.currentRoute()
        else { return nil }
        guard await self.session.currentOperatorScopes(ifCurrentRoute: route) != nil else { return nil }
        let credentials = await self.session.controlUIDashboardLegacyCredentials(ifCurrentRoute: route)
        guard self.isCurrent(), await self.session.currentRoute() == route else { return nil }
        return credentials
    }

    func authorize(nonce: String, signedAt: Int64) async throws -> IOSDashboardNativeGatewayAuthReply {
        guard self.isCurrent(), let route = await self.currentRoute(),
              await self.session.currentOperatorScopes(ifCurrentRoute: route) != nil
        else { throw CancellationError() }
        let json = try await self.session.controlUIDashboardAuthorization(
            ifCurrentRoute: route,
            nonce: nonce,
            signedAtMs: signedAt)
        guard self.isCurrent(), await self.session.currentRoute() == route,
              let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let auth = object["auth"] as? [String: String]
        else { throw CancellationError() }
        let deviceToken = auth["deviceToken"]
        if let deviceToken, self.accessPrincipal != nil,
           !Self.accessBindingAllowsDeviceToken(
               deviceToken,
               principal: self.accessPrincipal,
               gatewayID: self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID,
               profile: self.config.nodeOptions.deviceIdentityProfile)
        {
            throw CancellationError()
        }
        return IOSDashboardNativeGatewayAuthReply(json: json) { [weak self] in
            guard let self, self.isCurrent(), await self.session.currentRoute() == route else { return false }
            guard let deviceToken, self.accessPrincipal != nil else { return true }
            return Self.accessBindingAllowsDeviceToken(
                deviceToken,
                principal: self.accessPrincipal,
                gatewayID: self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID,
                profile: self.config.nodeOptions.deviceIdentityProfile)
        }
    }

    func isCurrent() -> Bool {
        guard let appModel = self.appModel,
              appModel.operatorAuthorityGeneration == self.authorityGeneration,
              appModel.isOperatorGatewayConnected,
              !appModel.isAppleReviewDemoModeEnabled, !appModel.isScreenshotFixtureModeEnabled,
              let current = appModel.activeGatewayConnectConfig,
              current.hasSameControlUIInputs(as: self.config),
              current.ingressAuthorization?.principal == self.accessPrincipal,
              self.config.ingressAuthorization?.isCurrent() ?? true
        else { return false }
        return true
    }

    static func accessBindingAllowsDeviceToken(
        _ token: String,
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        profile: GatewayDeviceIdentityProfile,
        store: GatewayAccessDeviceAuthBindingStore = .shared) -> Bool
    {
        guard let principal else { return true }
        let stored = store.storedDeviceAuth(role: "operator", gatewayID: gatewayID, profile: profile)
        return stored?.entry.token == token && store.allowsStoredDeviceAuth(
            entry: stored,
            principal: principal,
            gatewayID: gatewayID,
            role: "operator",
            profile: profile,
            fallbackAllowed: true)
    }

    private func currentRoute() async -> GatewayNodeSessionRoute? {
        guard self.isCurrent() else { return nil }
        let gatewayID = self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID
        let route = await self.session.currentRoute(ifGatewayID: gatewayID)
        guard self.isCurrent(), await self.session.currentRoute() == route else { return nil }
        return route
    }
}

@MainActor
final class IOSDashboardNativeGatewayAuthDocument: NSObject, WKScriptMessageHandlerWithReply {
    static let messageHandlerName = "OpenClawNativeGatewayAuth"

    private let provider: IOSDashboardNativeGatewayAuthProvider?
    private let expectedOrigin: GatewayTLSAuthority?
    private let allowedMainFramePathPrefix: String?
    private let accessAdmissionIsCurrent: AuthenticatedControlUIAccessCookieInstaller.Admission?
    private weak var webView: WKWebView?
    private var documentGeneration = UUID()
    private var isRetired = false

    init(
        url: URL,
        allowedMainFramePathPrefix: String?,
        provider: IOSDashboardNativeGatewayAuthProvider?,
        accessAdmissionIsCurrent: AuthenticatedControlUIAccessCookieInstaller.Admission?)
    {
        self.expectedOrigin = GatewayTLSAuthority(url: url)
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix
        self.provider = provider
        self.accessAdmissionIsCurrent = accessAdmissionIsCurrent
    }

    func attach(to webView: WKWebView) {
        self.webView = webView
        self.isRetired = false
        self.documentGeneration = UUID()
    }

    func beginNavigation() {
        self.documentGeneration = UUID()
    }

    func retire() {
        self.isRetired = true
        self.documentGeneration = UUID()
        self.webView = nil
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.messageHandlerName,
              let webView = self.webView,
              message.webView === webView, message.frameInfo.isMainFrame,
              self.isTrustedURL(message.frameInfo.request.url),
              self.isTrustedURL(webView.url),
              self.accessAdmissionIsCurrent?() ?? true,
              let provider = self.provider, provider.isCurrent(),
              let request = IOSDashboardNativeGatewayAuthRequest(message.body)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        let documentGeneration = self.documentGeneration
        Task { @MainActor [weak self, weak webView] in
            do {
                let response = try await provider.authorize(nonce: request.nonce, signedAt: request.signedAt)
                guard let self, let webView,
                      self.isCurrentDocument(documentGeneration, webView: webView),
                      provider.isCurrent(), await response.isCurrent(),
                      let value = try? JSONSerialization.jsonObject(with: response.json)
                else { throw CancellationError() }
                replyHandler(["id": request.id, "result": value], nil)
            } catch {
                replyHandler(["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            }
        }
    }

    private func isCurrentDocument(_ generation: UUID, webView: WKWebView) -> Bool {
        guard !self.isRetired, self.documentGeneration == generation, self.webView === webView,
              self.isTrustedURL(webView.url)
        else { return false }
        return self.accessAdmissionIsCurrent?() ?? true
    }

    private func isTrustedURL(_ url: URL?) -> Bool {
        guard let url, GatewayTLSAuthority(url: url) == self.expectedOrigin else { return false }
        guard let prefix = self.allowedMainFramePathPrefix else { return true }
        let path = url.path
        return path == prefix || path.hasPrefix(prefix.hasSuffix("/") ? prefix : prefix + "/")
    }
}
