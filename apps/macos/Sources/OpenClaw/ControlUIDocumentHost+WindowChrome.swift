import AppKit
import OpenClawKit
import WebKit

@MainActor
private final class ControlUIWindowDragMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: ControlUIDocumentHost?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveWindowDragMessage(message)
    }
}

extension ControlUIDocumentHost {
    private static let windowDragMessageHandlerName = "openclawWindowDrag"
    static let nativeTitlebarCSS = ":root { --openclaw-native-titlebar-height: 52px; }"

    func registerWindowChromeHandler() {
        let controller = self.webView.configuration.userContentController
        let handler = ControlUIWindowDragMessageHandler()
        handler.owner = self
        controller.add(handler, name: Self.windowDragMessageHandlerName)
    }

    /// Script refreshes replace URL-scoped chrome, while WebKit retains the handler.
    func installWindowChromeScript() {
        let controller = self.webView.configuration.userContentController
        // Start before the web header measures its band; document.head may not
        // exist yet, so attach to the root as soon as the parser creates it.
        let script = """
        const install = () => {
          if (!document.documentElement) return false;
          const style = document.createElement('style');
          style.textContent = \(WebViewJavaScriptSupport.jsValue(Self.nativeTitlebarCSS));
          document.documentElement.appendChild(style);
          return true;
        };
        if (!install()) {
          const observer = new MutationObserver(() => {
            if (install()) observer.disconnect();
          });
          observer.observe(document, {childList: true});
        }
        """
        controller.addUserScript(WKUserScript(
            source: Self.scopedDashboardScript(script, url: self.currentURL),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    /// The Control UI's passive chrome and the native failure page's background
    /// ask the window to take over the in-flight mouse gesture because
    /// WKWebView swallows titlebar-style drags.
    fileprivate func receiveWindowDragMessage(_ message: WKScriptMessage) {
        let isNativeFailureDocument = self.isShowingFailurePage &&
            message.frameInfo.request.url?.absoluteString == "about:blank" &&
            self.webView.url?.absoluteString == "about:blank"
        guard message.name == Self.windowDragMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              isNativeFailureDocument ||
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              Self.isWindowDragRequest(message.body),
              let window = self.webView.window
        else {
            return
        }
        // The script message arrives async; during a press the app's current
        // event is still the initiating left-mouse-down (or a later drag). A
        // finished click leaves left-mouse-up here and starts no drag.
        guard let event = NSApp.currentEvent,
              event.type == .leftMouseDown || event.type == .leftMouseDragged,
              event.window === window
        else {
            return
        }
        DashboardWindowDragGesture.handle(event, in: window)
    }

    static func isWindowDragRequest(_ body: Any) -> Bool {
        guard let payload = body as? [String: Any] else { return false }
        return payload["type"] as? String == "window-drag"
    }
}
