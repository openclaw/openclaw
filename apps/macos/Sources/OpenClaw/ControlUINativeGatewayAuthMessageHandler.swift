import Foundation
import WebKit

@MainActor
final class ControlUINativeGatewayAuthMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"
    weak var owner: ControlUIDocumentHost?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.name, let owner,
              message.webView === owner.webView, message.frameInfo.isMainFrame,
              ControlUIDocumentHost.isTrustedLinkSource(
                  message.frameInfo.request.url, dashboardURL: owner.currentURL),
              let request = DashboardNativeGatewayAuthRequest(message.body),
              let provider = owner.nativeGatewayAuthProvider,
              owner.canUseNativeGatewayAuth(sourceID: owner.sourceID)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        let sourceID = owner.sourceID
        let providerRevision = owner.nativeGatewayAuthRevision
        Task { @MainActor [weak owner] in
            do {
                let response = try await provider(request.nonce, request.signedAt)
                let result = try JSONSerialization.jsonObject(with: response.json)
                guard let owner, owner.canUseNativeGatewayAuth(sourceID: sourceID),
                      owner.nativeGatewayAuthRevision == providerRevision,
                      response.isCurrent()
                else { throw CancellationError() }
                replyHandler(["id": request.id, "result": result], nil)
            } catch {
                replyHandler(["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            }
        }
    }
}

extension ControlUIDocumentHost {
    func canUseNativeGatewayAuth(sourceID: String) -> Bool {
        !Task.isCancelled && self.auth.usesNativeDevice && self.sourceID == sourceID &&
            self.isNativeAuthAvailable() && self.hasCurrentBrowserSession && !self.isShowingFailurePage &&
            Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }
}
