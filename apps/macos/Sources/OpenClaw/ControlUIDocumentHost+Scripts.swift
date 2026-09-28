import Foundation
import OpenClawKit
import WebKit

extension ControlUIDocumentHost {
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
