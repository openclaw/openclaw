import Foundation
import OpenClawKit
import WebKit

struct LobbyComponentSelection: Equatable {
    let name: String
    let instanceID: String
}

/// The trusted dashboard hands conversational text to the existing native conversation owner.
@MainActor
final class LobbyPromptBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "openclawLobbyPrompt"
    let url: URL
    let accept: (String) -> Bool
    var onSelection: ((LobbyComponentSelection?) -> Void)?
    weak var webView: WKWebView?

    init(url: URL, accept: @escaping (String) -> Bool) {
        self.url = url
        self.accept = accept
    }

    static func text(_ body: Any) -> String? {
        guard let body = body as? [String: Any], let raw = body["text"] as? String else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 4000, !text.hasPrefix("/"), !text.hasPrefix("!") else { return nil }
        return text
    }

    static func matches(_ source: URL?, expected: URL) -> Bool {
        guard let source, let authority = GatewayTLSAuthority(url: expected) else { return false }
        return GatewayTLSAuthority(url: source) == authority &&
            source.path(percentEncoded: true) == expected.path(percentEncoded: true)
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              !webView.isLoading, webView.window != nil,
              Self.matches(message.frameInfo.request.url, expected: self.url),
              Self.matches(webView.url, expected: self.url)
        else {
            replyHandler(false, nil)
            return
        }
        if let body = message.body as? [String: Any], body["kind"] as? String == "selection" {
            if body["name"] is NSNull {
                self.onSelection?(nil)
            } else {
                guard let name = body["name"] as? String,
                      name.range(of: "^[a-z0-9][a-z0-9._-]{0,63}$", options: .regularExpression) != nil,
                      let instanceID = body["instanceId"] as? String, !instanceID.isEmpty, instanceID.count <= 256
                else { replyHandler(false, nil)
                    return
                }
                self.onSelection?(LobbyComponentSelection(name: name, instanceID: instanceID))
            }
            replyHandler(true, nil)
            return
        }
        guard let text = Self.text(message.body) else { replyHandler(false, nil)
            return
        }
        // No await between admission and custody; send() reserves the normal owner's draft.
        replyHandler(self.accept(text), nil)
    }

    var script: String? {
        IOSDeviceSettingsBridge.originGatedScript(
            """
            document.addEventListener('openclaw-widget-prompt', event => {
              if (event.defaultPrevented || typeof event.detail?.respond !== 'function') return;
              event.preventDefault();
              event.stopPropagation();
              event.detail.respond(window.webkit.messageHandlers.openclawLobbyPrompt
                .postMessage({text: event.detail.text}).then(accepted => accepted === true));
            });
            """, url: self.url)
    }
}
