import Foundation
import OpenClawKit
import WebKit

@MainActor
final class ControlUINativeGatewayAuthMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"
    weak var owner: ControlUIDocumentHost?
    private var enrollment: (sourceID: String, revision: UInt64, response: DashboardNativeGatewayAuth)?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        if let body = message.body as? [String: Any], body["action"] as? String == "enrollProfile" {
            self.enroll(body, message: message, replyHandler: replyHandler)
            return
        }
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
                self.enrollment = (sourceID, providerRevision, response)
                replyHandler(["id": request.id, "result": result], nil)
            } catch {
                replyHandler(["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            }
        }
    }

    private func enroll(
        _ body: [String: Any],
        message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard Set(body.keys) == ["id", "action", "params"], let id = body["id"] as? String,
              !id.isEmpty, id.utf8.count <= 128, let owner, let enrollment,
              enrollment.sourceID == owner.sourceID, enrollment.revision == owner.nativeGatewayAuthRevision,
              message.name == Self.name, message.webView === owner.webView, message.frameInfo.isMainFrame,
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: owner.currentURL),
              owner.canUseNativeGatewayAuth(sourceID: enrollment.sourceID), enrollment.response.isCurrent(),
              let command = enrollment.response.enrollProfile,
              let value = body["params"], let data = try? JSONSerialization.data(withJSONObject: value),
              let params = try? JSONDecoder().decode(GatewayProfileEnrollment.self, from: data)
        else {
            replyHandler(nil, "Native personal setup is unavailable for this document.")
            return
        }
        Task { @MainActor [weak owner] in
            do {
                let result = try await command(params)
                guard let owner, owner.sourceID == enrollment.sourceID,
                      message.webView === owner.webView,
                      ControlUIDocumentHost.isTrustedLinkSource(owner.webView.url, dashboardURL: owner.currentURL)
                else { throw CancellationError() }
                try replyHandler(["id": id, "result": JSONSerialization.jsonObject(with: result)], nil)
            } catch {
                replyHandler(
                    ["id": id, "error": "Native personal setup did not finish. Reconnect and check Profile."],
                    nil)
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
