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
                source: Self.scopedDashboardScript(capabilityScript, url: url),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        // Narrow widths need no rules here: the Control UI's own
        // `html.openclaw-native-macos` styles fold the titlebar clearance into
        // the drawer topbar row (layout.mobile.css); their body-qualified
        // !important selectors also outrank the rules older app builds inject.
        let css = """
        \(DashboardDeviceSymbolStyle.css())
        html.openclaw-native-macos {
          /* Matches the 52pt unified-toolbar titlebar so the web buttons and the
             traffic lights share one vertical center. */
          --openclaw-native-titlebar-height: 52px;
        }
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
                source: Self.scopedDashboardScript(script, url: url),
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true))
    }

    static func installNativeAuthScript(
        into userContentController: WKUserContentController,
        url: URL,
        auth: DashboardWindowAuth)
    {
        guard auth.hasCredential || auth.usesBrowserIdentity else { return }
        let credentials: [String: Any?] = [
            "gatewayUrl": auth.gatewayUrl,
            "token": auth.token,
            "password": auth.password,
        ]
        var payload = credentials.compactMapValues { $0 }
        if auth.usesBrowserIdentity {
            // Explicit absence retires an earlier shared login at this browser origin.
            payload["token"] = NSNull()
            payload["password"] = NSNull()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        let script = """
        (() => {
          try {
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: \(json),
              configurable: true,
            });
          } catch {}
        })();
        """
        userContentController.addUserScript(
            WKUserScript(
                source: Self.scopedDashboardScript(script, url: url),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
    }

    /// The dashboard can visit its identity provider. Recheck in JavaScript,
    /// where execution occurs, so queued evaluations cannot disclose native data after a redirect.
    static func scopedDashboardScript(_ script: String, url: URL) -> String {
        """
        (() => {
          if (location.protocol !== "http:" && location.protocol !== "https:") return;
          if (location.origin !== \(WebViewJavaScriptSupport.jsValue(self.originString(for: url)))) return;
          const allowedPath = \(WebViewJavaScriptSupport.jsValue(self.allowedPath(for: url)));
          if (allowedPath !== "/" && !location.pathname.startsWith(allowedPath)) return;
          \(script)
        })();
        """
    }

    static func originString(for url: URL) -> String {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return "" }
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        var out = "\(scheme)://\(hostPart)"
        // Browsers omit default ports even when a saved native profile makes them explicit.
        if let port = url.port, port != defaultPort(for: scheme) {
            out += ":\(port)"
        }
        return out
    }

    static func allowedPath(for url: URL) -> String {
        // Match location.pathname; URL.path decodes escapes and removes the mount's trailing slash.
        let path = url.path(percentEncoded: true).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return "/" }
        return path.hasSuffix("/") ? path : path + "/"
    }
}
