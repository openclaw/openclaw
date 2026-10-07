import CoreFoundation
import Foundation
import OpenClawKit
import WebKit

/// Signs Control UI connect challenges so the page never holds the device key or device token.
/// Mirrors the macOS `OpenClawNativeGatewayAuth` contract; the app stays the sole grant owner.
@MainActor
final class ControlUINativeGatewayAuthHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"

    struct Request {
        let id: String
        let nonce: String
        let signedAt: Int64

        /// Same wire contract as macOS `DashboardNativeGatewayAuthRequest`. The challenge uses the
        /// server clock, so only the representation is validated; the gateway owns nonce freshness.
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

    init(config: GatewayConnectConfig, expectedToken: String) {
        self.config = config
        self.expectedToken = expectedToken
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.name,
              IOSDeviceSettingsBridge.isTrustedSource(
                  message.frameInfo.request.url,
                  webViewURL: self.webView?.url,
                  gatewayURL: self.config.url,
                  isMainFrame: message.frameInfo.isMainFrame,
                  isHostingWebView: message.webView != nil && message.webView === self.webView),
              let request = Request(message.body)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        // Signing is synchronous, so the authority revalidated here is the one the reply carries.
        guard let result = Self.signedResult(
            request: request, config: self.config, expectedToken: self.expectedToken)
        else {
            replyHandler(
                ["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            return
        }
        replyHandler(["id": request.id, "result": result], nil)
    }

    /// Reloads identity and grant at challenge time; a rotated or revoked token yields nil.
    static func signedResult(
        request: Request,
        config: GatewayConnectConfig,
        expectedToken: String) -> [String: Any]?
    {
        guard let authorization = AuthenticatedControlUI.storedOperatorAuthorization(
            config: config, expectedToken: expectedToken)
        else { return nil }
        let identity = authorization.identity
        let scopes = authorization.entry.scopes
        let token = authorization.entry.token.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = GatewayDeviceAuthPayload.Fields(
            deviceId: identity.deviceId,
            client: .init(id: config.nodeOptions.clientId, mode: "ui"),
            role: "operator",
            scopes: scopes,
            signedAtMs: request.signedAt,
            token: token,
            nonce: request.nonce)
        // The gateway verifies the same v2 payload the page signed before this cutover.
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
            "auth": ["deviceToken": token],
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
