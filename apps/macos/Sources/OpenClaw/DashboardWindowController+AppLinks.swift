import Foundation
import WebKit

@MainActor
final class DashboardAppLinkMessageHandler: NSObject, WKScriptMessageHandler {
    static let name = "openclawAppLink"
    static let world = WKContentWorld.world(name: "OpenClaw App Links")
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        // WebKit supplies the world identity; page scripts cannot forge it or
        // access the handler installed only in this application's namespace.
        guard message.name == Self.name, message.world === Self.world else { return }
        self.owner?.receiveAppLinkMessage(message)
    }
}

extension DashboardWindowController {
    static func installNativeAppLinkScript(into controller: WKUserContentController, url: URL) {
        let script = """
        window.addEventListener('click', event => {
          if (!event.isTrusted || event.defaultPrevented || event.button !== 0 ||
              event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
          if (!anchor || anchor.hasAttribute('download') || anchor.hasAttribute('data-file-path')) return;
          if (anchor.target && anchor.target !== '_self' && anchor.target !== '_blank') return;
          const url = new URL(anchor.href, location.href);
          if (url.protocol !== 'openclaw:') return;
          window.webkit.messageHandlers.\(DashboardAppLinkMessageHandler.name).postMessage(url.href);
          event.preventDefault();
        });
        """
        // Keyboard Enter and physical clicks both produce trusted DOM clicks.
        // The isolated world protects this listener and its handler from page code.
        controller.addUserScript(WKUserScript(
            source: Self.scopedDashboardScript(script, url: url),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: DashboardAppLinkMessageHandler.world))
    }
}
