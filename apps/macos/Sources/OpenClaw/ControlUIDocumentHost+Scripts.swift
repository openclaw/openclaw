import Foundation
import OpenClawKit
import WebKit

extension ControlUIDocumentHost {
    func installNativeAuthScript() {
        let controller = self.webView.configuration.userContentController
        // WebKit only supports removing all scripts. Preserve other capabilities
        // and replace this owner's exact projection, including after disconnect.
        let scripts = controller.userScripts.filter { $0 !== self.nativeAuthScript }
        controller.removeAllUserScripts()
        for script in scripts {
            controller.addUserScript(script)
        }
        self.nativeAuthScript = Self.installNativeAuthScript(
            into: controller, url: self.currentURL, auth: self.auth)
    }

    private static func installNativeAuthScript(
        into userContentController: WKUserContentController,
        url: URL,
        auth: DashboardWindowAuth) -> WKUserScript?
    {
        guard auth.hasCredential || auth.usesBrowserIdentity || auth.usesNativeDevice else { return nil }
        let credentials: [String: Any?] = [
            "gatewayUrl": auth.gatewayUrl,
            "token": auth.token,
            "password": auth.password,
        ]
        var payload = credentials.compactMapValues { $0 }
        if auth.usesNativeDevice {
            payload = auth.legacyCredentials
            payload["gatewayUrl"] = auth.gatewayUrl
            // Released UI must not prefer an earlier token over the accepted password.
            if payload["password"] != nil { payload["token"] = NSNull() }
            if !auth.hasAcceptedNativeBinding {
                payload["token"] = NSNull()
                payload["password"] = NSNull()
            }
            // Released UI consumes shared fields; current UI uses the native signer.
            payload["nativeConnectAuth"] = true
        }
        if auth.usesBrowserIdentity {
            // Explicit absence retires an earlier shared login at this browser origin.
            payload["token"] = NSNull()
            payload["password"] = NSNull()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
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
        let userScript = WKUserScript(
            source: Self.scopedDashboardScript(script, url: url),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        userContentController.addUserScript(userScript)
        return userScript
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
