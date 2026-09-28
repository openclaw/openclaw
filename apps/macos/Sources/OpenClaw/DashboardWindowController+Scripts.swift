import Foundation
import OpenClawKit
import WebKit

extension DashboardWindowController {
    static func installNativeChromeScript(into userContentController: WKUserContentController, url: URL) {
        // Deliberately no native fallback for pages that ignore this flag
        // (older gateway bundles, failure pages): they keep their own in-page
        // toggles plus back/forward gestures and the Cmd-[/] menu items.
        let capabilityScript = """
        window.__OPENCLAW_NATIVE_WEB_CHROME__ = true;
        window.addEventListener('openclaw:native-commands-state', () => {
          window.webkit.messageHandlers.openclawCommands.postMessage({type: 'commands-state'});
        });
        """
        userContentController.addUserScript(
            WKUserScript(
                source: ControlUIDocumentHost.scopedDashboardScript(capabilityScript, url: url),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        // Narrow widths need no rules here: the Control UI's own
        // `html.openclaw-native-macos` styles fold the titlebar clearance into
        // the drawer topbar row (layout.mobile.css); their body-qualified
        // !important selectors also outrank the rules older app builds inject.
        let css = """
        \(DashboardDeviceSymbolStyle.css())
        @media (min-width: 700px) {
          /* Both desktop navigation surfaces must clear AppKit's window controls
             and drag regions or their first interactive row becomes unreachable. */
          html.openclaw-native-macos .sidebar-shell,
          html.openclaw-native-macos .settings-sidebar__header {
            padding-top: max(14px, var(--openclaw-native-titlebar-height)) !important;
          }
        }
        """
        let script = """
        (() => {
          try {
            if (document.getElementById("openclaw-native-macos-chrome")) return;
            const style = document.createElement("style");
            style.id = "openclaw-native-macos-chrome";
            style.textContent = \(WebViewJavaScriptSupport.jsValue(css));
            document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-web-chrome");
            document.head.appendChild(style);
          } catch {}
        })();
        """
        userContentController.addUserScript(
            WKUserScript(
                source: ControlUIDocumentHost.scopedDashboardScript(script, url: url),
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true))
    }
}
