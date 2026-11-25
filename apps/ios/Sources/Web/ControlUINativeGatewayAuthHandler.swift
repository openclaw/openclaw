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

    private let provider: IOSDashboardNativeGatewayAuthProvider?
    private let gatewayURL: URL
    private let allowedMainFramePathPrefix: String?
    private let accessAdmissionIsCurrent: AuthenticatedControlUIAccessCookieInstaller.Admission?
    weak var webView: WKWebView?
    var document = IOSDeviceSettingsDocument()

    init(
        url: URL,
        allowedMainFramePathPrefix: String?,
        provider: IOSDashboardNativeGatewayAuthProvider?,
        accessAdmissionIsCurrent: AuthenticatedControlUIAccessCookieInstaller.Admission?)
    {
        self.gatewayURL = provider?.controlUIRootURL ?? url
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix
        self.provider = provider
        self.accessAdmissionIsCurrent = accessAdmissionIsCurrent
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard self.isAvailable(for: message),
              let provider = self.provider, provider.isCurrent(),
              let request = Request(message.body)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        let documentID = self.document.id
        Task { @MainActor [weak self] in
            do {
                let response = try await provider.authorize(nonce: request.nonce, signedAt: request.signedAt)
                // The last actor hop can outlive navigation, disconnect, or Access retirement.
                guard await response.isCurrent(), let self,
                      self.document.id == documentID, self.isAvailable(for: message),
                      provider.isCurrent(),
                      let value = try? JSONSerialization.jsonObject(with: response.json)
                else { throw CancellationError() }
                replyHandler(["id": request.id, "result": value], nil)
            } catch {
                replyHandler(["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            }
        }
    }

    private func isAvailable(for message: WKScriptMessage) -> Bool {
        guard message.name == Self.name, self.document.isAvailable,
              self.accessAdmissionIsCurrent?() ?? true,
              IOSDeviceSettingsBridge.isTrustedSource(
                  message.frameInfo.request.url,
                  webViewURL: self.webView?.url,
                  gatewayURL: self.gatewayURL,
                  isMainFrame: message.frameInfo.isMainFrame,
                  isHostingWebView: message.webView != nil && message.webView === self.webView)
        else { return false }
        guard let prefix = self.allowedMainFramePathPrefix else { return true }
        return [message.frameInfo.request.url, self.webView?.url].allSatisfy { url in
            guard let path = url?.path else { return false }
            return path == prefix || path.hasPrefix(prefix.hasSuffix("/") ? prefix : prefix + "/")
        }
    }
}
