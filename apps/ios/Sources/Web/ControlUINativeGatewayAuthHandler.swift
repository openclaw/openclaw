import CoreFoundation
import Foundation
import OpenClawKit
import WebKit

/// Signs Control UI connect challenges without exposing the device private key to page storage.
@MainActor
final class ControlUINativeGatewayAuthHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"

    struct Request {
        let id: String
        let nonce: String
        let signedAt: Int64

        /// Match the macOS challenge contract; the Gateway owns server-clock freshness checks.
        init?(_ body: Any) {
            guard let value = body as? [String: Any],
                  Set(value.keys) == ["id", "nonce", "signedAt"],
                  let id = value["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
                  let nonce = value["nonce"] as? String, !nonce.isEmpty, nonce.utf8.count <= 1024,
                  !nonce.contains("|"),
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

    private let config: GatewayConnectConfig
    private let expectedToken: String
    weak var webView: WKWebView?
    private weak var appModel: NodeAppModel?
    var document = IOSDeviceSettingsDocument()

    init(config: GatewayConnectConfig, expectedToken: String, appModel: NodeAppModel) {
        self.config = config
        self.expectedToken = expectedToken
        self.appModel = appModel
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard let appModel, self.isAvailable(for: message, appModel: appModel),
              let request = Request(message.body)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        let document = self.document.requestIdentity(authorityGeneration: appModel.operatorAuthorityGeneration)
        Task { @MainActor in
            let session = appModel.operatorSession
            let gatewayID = self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID
            guard let route = await session.currentRoute(ifGatewayID: gatewayID),
                  let binding = await session.authBinding(ifCurrentRoute: route)
            else {
                replyHandler(nil, "The native gateway connection is no longer current.")
                return
            }
            let scopes = await session.currentOperatorScopes(ifCurrentRoute: route).map { $0.sorted() }
            // Actor hops may outlive navigation, disconnect, or reassignment. Revalidate at signing.
            guard await session.currentRoute() == route,
                  self.document.accepts(document, authorityGeneration: appModel.operatorAuthorityGeneration),
                  self.isAvailable(for: message, appModel: appModel),
                  let result = Self.signedResult(
                      request: request,
                      config: self.config,
                      expectedToken: self.expectedToken,
                      binding: binding,
                      scopes: scopes)
            else {
                replyHandler(nil, "The native gateway connection is no longer current.")
                return
            }
            replyHandler(["id": request.id, "result": result], nil)
        }
    }

    private func isAvailable(for message: WKScriptMessage, appModel: NodeAppModel) -> Bool {
        message.name == Self.name && self.document.isAvailable && appModel.isOperatorGatewayConnected &&
            appModel.activeGatewayConnectConfig?.hasSameControlUIInputs(as: self.config) == true &&
            IOSDeviceSettingsBridge.isTrustedSource(
                message.frameInfo.request.url,
                webViewURL: self.webView?.url,
                gatewayURL: AuthenticatedControlUI.pageURL(config: self.config, path: "", queryItems: []),
                isMainFrame: message.frameInfo.isMainFrame,
                isHostingWebView: message.webView != nil && message.webView === self.webView)
    }

    /// Reloads the stored grant and preserves the credential selected by the live native socket.
    static func signedResult(
        request: Request,
        config: GatewayConnectConfig,
        expectedToken: String,
        binding: GatewayAuthBinding,
        scopes: [String]?) -> [String: Any]?
    {
        guard let authorization = AuthenticatedControlUI.storedOperatorAuthorization(
            config: config, expectedToken: expectedToken),
            authorization.identity.deviceId == binding.deviceId
        else { return nil }
        let identity = authorization.identity
        let scopes = scopes ?? authorization.entry.scopes
        let auth: [String: String]
        let signatureToken: String?
        switch binding.source {
        case .sharedToken:
            guard let token = config.token?.trimmedNonEmpty else { return nil }
            auth = ["token": token]
            signatureToken = token
        case .password:
            guard let password = config.password?.trimmedNonEmpty else { return nil }
            auth = ["password": password]
            signatureToken = nil
        case .deviceToken, .bootstrapToken, .none:
            let token = authorization.entry.token.trimmingCharacters(in: .whitespacesAndNewlines)
            auth = ["deviceToken": token]
            signatureToken = token
        }
        let fields = GatewayDeviceAuthPayload.Fields(
            deviceId: identity.deviceId,
            client: .init(id: config.nodeOptions.clientId, mode: "ui"),
            role: "operator",
            scopes: scopes,
            signedAtMs: request.signedAt,
            token: signatureToken,
            nonce: request.nonce)
        let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(fields: fields)
        guard let signature = DeviceIdentityStore.signPayload(payload, identity: identity),
              let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
        else { return nil }
        return [
            "client": [
                "id": config.nodeOptions.clientId,
                "mode": "ui",
                "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                "platform": InstanceIdentity.platformString,
                "deviceFamily": InstanceIdentity.deviceFamily,
                "instanceId": InstanceIdentity.instanceId,
            ],
            "scopes": scopes,
            "auth": auth,
            "device": [
                "id": identity.deviceId,
                "publicKey": publicKey,
                "signature": signature,
                "signedAt": request.signedAt,
                "nonce": request.nonce,
            ],
        ]
    }
}
