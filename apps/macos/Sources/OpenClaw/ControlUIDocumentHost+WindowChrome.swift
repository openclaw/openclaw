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

    func registerWindowChromeHandler() {
        let controller = self.webView.configuration.userContentController
        let handler = ControlUIWindowDragMessageHandler()
        handler.owner = self
        controller.add(handler, name: Self.windowDragMessageHandlerName)
    }

    /// Script refreshes replace URL-scoped chrome, while WebKit retains the handler.
    func installWindowChromeScript() {
        let controller = self.webView.configuration.userContentController
        // Page zoom scales CSS pixels, but AppKit's titlebar and traffic lights
        // remain in points. Keep their reserved band fixed through zoom and reload.
        let zoom = self.webView.pageZoom
        let css = """
        :root {
          --openclaw-native-titlebar-height: \(String(format: "%.8g", 52 / zoom))px;
          --openclaw-native-controls-inset: \(String(format: "%.8g", 92 / zoom))px;
          --openclaw-native-chrome-scale: \(String(format: "%.8g", 1 / zoom));
        }
        """
        // Start before the web header measures its band; document.head may not
        // exist yet, so attach to the root as soon as the parser creates it.
        let script = """
        window.__OPENCLAW_NATIVE_CONTENT_ZOOM__ = {
          supported: true,
          adoptLegacyTextScale: async textScale => {
            await window.webkit.messageHandlers.openclawDeviceSettings.postMessage({type: 'adopt-legacy-text-scale', textScale});
          }
        };
        const install = () => {
          if (!document.documentElement) return false;
          const style = document.getElementById('openclaw-native-titlebar') || document.createElement('style');
          style.id = 'openclaw-native-titlebar';
          style.textContent = \(WebViewJavaScriptSupport.jsValue(css));
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
        let next = WKUserScript(
            source: Self.scopedDashboardScript(script, url: self.currentURL),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        let scripts = controller.userScripts.filter { $0 !== self.windowChromeScript }
        controller.removeAllUserScripts()
        for existing in scripts { controller.addUserScript(existing) }
        controller.addUserScript(next)
        self.windowChromeScript = next
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(script, url: self.currentURL))
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
        (body as? [String: Any])?["type"] as? String == "window-drag"
    }
}
