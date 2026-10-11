import CoreFoundation
import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import WebKit

/// Reuses the native challenge bridge without exporting a paired device grant.
@MainActor
final class IOSPersonalGatewayAuthBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"
    private let appModel: NodeAppModel
    private let config: GatewayConnectConfig
    private let url: URL
    private let authorityGeneration: UInt64
    private weak var webView: WKWebView?
    private var document = IOSDeviceSettingsDocument()

    init(appModel: NodeAppModel, config: GatewayConnectConfig, url: URL) {
        self.appModel = appModel
        self.config = config
        self.url = url
        self.authorityGeneration = appModel.operatorAuthorityGeneration
    }

    func attach(to webView: WKWebView) {
        self.webView = webView
        self.observeAuthority()
    }

    func detach() {
        self.document.retire()
        self.webView = nil
    }

    func startNavigation() {
        self.document.startNavigation()
    }

    func commitNavigation() {
        self.document.commitNavigation()
    }

    func failProvisionalNavigation() {
        self.document.failProvisionalNavigation()
    }

    func retireDocument() {
        self.document.retire()
    }

    private var hasCurrentAuthority: Bool {
        self.config.personalTailscaleAuthentication && self.appModel.isOperatorGatewayConnected &&
            self.appModel.operatorAuthorityGeneration == self.authorityGeneration &&
            self.appModel.activeGatewayConnectConfig?.hasSameControlUIInputs(as: self.config) == true
    }

    private func observeAuthority() {
        guard self.webView != nil else { return }
        withObservationTracking {
            _ = self.hasCurrentAuthority
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, let webView = self.webView else { return }
                // A connected WebView must not outlive the native principal that admitted it.
                if !self.hasCurrentAuthority {
                    self.document.retire()
                    webView.stopLoading()
                    webView.loadHTMLString(
                        "<p>Personal sign-in changed. Reopen this Dashboard after reconnecting in the app.</p>",
                        baseURL: nil)
                } else {
                    self.observeAuthority()
                }
            }
        }
    }

    private func isCurrent(_ request: IOSDeviceSettingsDocument.RequestIdentity) -> Bool {
        guard let currentURL = self.webView?.url else { return false }
        return self.hasCurrentAuthority &&
            self.document.accepts(request, authorityGeneration: self.appModel.operatorAuthorityGeneration) &&
            GatewayTLSAuthority(url: currentURL) == GatewayTLSAuthority(url: self.url)
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.name, message.webView === self.webView, message.frameInfo.isMainFrame,
              let source = message.frameInfo.request.url,
              GatewayTLSAuthority(url: source) == GatewayTLSAuthority(url: self.url),
              let body = message.body as? [String: Any], Set(body.keys) == ["id", "nonce", "signedAt"],
              let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
              let nonce = body["nonce"] as? String, !nonce.isEmpty, nonce.utf8.count <= 512,
              !nonce.contains("|"), let timestamp = body["signedAt"] as? NSNumber,
              CFGetTypeID(timestamp) != CFBooleanGetTypeID(), timestamp.doubleValue.isFinite,
              timestamp.doubleValue.rounded() == timestamp.doubleValue,
              timestamp.doubleValue > 0, timestamp.doubleValue <= 9_007_199_254_740_991
        else {
            replyHandler(nil, "Invalid native Gateway authentication request.")
            return
        }
        let request = self.document.requestIdentity(authorityGeneration: self.appModel.operatorAuthorityGeneration)
        Task { @MainActor [weak self] in
            do {
                guard let self, self.isCurrent(request),
                      let route = await self.appModel.operatorSession.currentRoute(
                          ifGatewayID: self.config.effectiveStableID)
                else { throw CancellationError() }
                let scope = try await self.config.verifiedPersonalRecoveryScope(session: self.appModel.operatorSession)
                guard let currentScopes = await self.appModel.operatorSession
                    .currentOperatorScopes(ifCurrentRoute: route),
                    let identity = DeviceIdentityStore.loadOrCreatePersisted(), self.isCurrent(request),
                    await self.appModel.operatorSession
                        .currentRoute(ifGatewayID: self.config.effectiveStableID) == route
                else { throw CancellationError() }
                let scopes = currentScopes.sorted()
                let clientId = self.config.nodeOptions.clientId
                let signedAt = timestamp.int64Value
                let fields = GatewayDeviceAuthPayload.Fields(
                    deviceId: identity.deviceId,
                    client: .init(id: clientId, mode: "ui"),
                    role: "operator",
                    scopes: scopes,
                    signedAtMs: signedAt,
                    token: nil,
                    nonce: nonce)
                let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(fields: fields)
                guard let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
                    payload: payload, identity: identity, signedAtMs: signedAt, nonce: nonce),
                    self.isCurrent(request)
                else { throw CancellationError() }
                let result: [String: OpenClawProtocol.AnyCodable] = [
                    "client": .init([
                        "id": clientId, "mode": "ui", "platform": InstanceIdentity.platformString,
                        "deviceFamily": InstanceIdentity.deviceFamily, "instanceId": InstanceIdentity.instanceId,
                        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                    ]),
                    "device": .init(device), "scopes": .init(scopes), "auth": .init([String: String]()),
                    "requiredAuthMethod": .init("tailscale"), "expectedRecoveryScope": .init(scope),
                ]
                let reply = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result))
                guard self.isCurrent(request) else { throw CancellationError() }
                replyHandler(["id": id, "result": reply], nil)
            } catch {
                replyHandler(["id": id, "error": "Personal sign-in is unavailable. Reconnect in the app."], nil)
            }
        }
    }
}
