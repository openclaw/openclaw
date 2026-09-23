import Foundation

/// Renders the static error page the dashboard window shows when the Control
/// UI cannot load. Presentation-only; kept out of `DashboardWindowController`
/// so the controller stays focused on window/navigation behavior.
enum DashboardFailurePage {
    struct SignedOut: Equatable {
        let target: DashboardGatewayTarget
        let name: String
        let host: String
        let expiresAt: Date
    }

    static func html(
        signedOut: SignedOut,
        signingIn: Bool = false,
        browserAttempt: UUID? = nil,
        error: String? = nil,
        now: Date = Date()) -> String
    {
        let host = signedOut.host
        let elapsed = age(from: signedOut.expiresAt, now: now)
        let message = signedOut.expiresAt <= now
            ? String(
                format: String(localized: "Your browser sign-in to %@ expired %@. Sign in again to continue."),
                host,
                elapsed)
            : String(
                format: String(localized: "Your browser sign-in to %@ expires soon. Sign in again to continue."),
                host)
        let action = signingIn ? "reconnect-cancel" : "reconnect"
        let label = signingIn ? String(localized: "Cancel") : String(localized: "Sign in again")
        var button = """
        <button type="button" data-id="\(self.htmlEscape(signedOut.target.bridgeID))"
          onclick="window.webkit.messageHandlers.openclawGateways
            .postMessage({type:'\(action)',id:this.dataset.id})">\(self.htmlEscape(label))</button>
        """
        if signingIn, let browserAttempt {
            let browserLabel = self.htmlEscape(String(localized: "Open browser"))
            button += "\n" + """
            <button type="button" data-id="\(self.htmlEscape(signedOut.target.bridgeID))"
              onclick="window.webkit.messageHandlers.openclawGateways
                .postMessage({type:'reconnect-browser',id:this.dataset.id,
                  attempt:'\(browserAttempt.uuidString)'})">\(browserLabel)</button>
            """
        }
        return self.html(
            title: String(format: String(localized: "Signed out of %@"), signedOut.name),
            message: message,
            detail: error ?? (signingIn ? String(localized: "Complete sign-in in your browser…") : nil),
            url: nil,
            primaryButton: button)
    }

    static func html(
        title: String, message: String, detail: String?, url: URL?, primaryButton: String = "") -> String
    {
        let connectionTitle = self.htmlEscape(String(localized: "Connection Settings…"))
        let detailHTML = detail.map { "<p class=\"detail\">\(self.htmlEscape($0))</p>" } ?? ""
        let urlHTML = url
            .map { "<code>\(self.htmlEscape(GatewayEndpointStore.diagnosticURLString(for: $0)))</code>" } ?? ""
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            :root { color-scheme: light dark; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: #101114;
              color: rgba(255,255,255,.92);
              font: 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
            }
            main {
              width: min(540px, calc(100vw - 72px));
              padding: 34px;
              border: 1px solid rgba(255,255,255,.12);
              border-radius: 22px;
              background: rgba(255,255,255,.035);
              box-shadow: 0 28px 90px rgba(0,0,0,.36);
              line-height: 1.45;
            }
            .badge {
              width: 44px;
              height: 44px;
              display: grid;
              place-items: center;
              margin-bottom: 20px;
              border-radius: 14px;
              background: rgba(255,255,255,.07);
              color: #ff746b;
              font-size: 24px;
            }
            h1 {
              margin: 0 0 12px;
              font-size: 24px;
              line-height: 1.16;
              font-weight: 700;
              letter-spacing: 0;
            }
            p {
              margin: 0;
              color: rgba(255,255,255,.76);
              font-size: 16px;
            }
            .detail {
              margin-top: 14px;
              color: rgba(255,255,255,.56);
              font-size: 13px;
            }
            code {
              display: block;
              margin-top: 18px;
              padding: 12px;
              border: 1px solid rgba(255,255,255,.08);
              border-radius: 10px;
              background: rgba(0,0,0,.26);
              color: rgba(255,255,255,.76);
              overflow-wrap: anywhere;
              font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            button {
              margin-top: 22px;
              padding: 9px 14px;
              border: 1px solid currentColor;
              border-radius: 8px;
              background: transparent;
              color: inherit;
              font: inherit;
              cursor: pointer;
            }
            @media (prefers-color-scheme: light) {
              body { background: #f5f6f8; color: rgba(0,0,0,.86); }
              main {
                background: rgba(255,255,255,.84);
                border-color: rgba(0,0,0,.1);
                box-shadow: 0 28px 90px rgba(0,0,0,.12);
              }
              .badge { background: rgba(0,0,0,.06); }
              p { color: rgba(0,0,0,.68); }
              .detail { color: rgba(0,0,0,.54); }
              code {
                background: rgba(0,0,0,.05);
                border-color: rgba(0,0,0,.08);
                color: rgba(0,0,0,.68);
              }
            }
          </style>
        </head>
        <body>
          <main>
            <div class="badge">!</div>
            <h1>\(self.htmlEscape(title))</h1>
            <p>\(self.htmlEscape(message))</p>
            \(detailHTML)
            \(urlHTML)
            \(primaryButton)
            <button type="button" onclick="window.webkit.messageHandlers.openclawDeviceSettings
              .postMessage({type:'open',panel:'connection'})">\(connectionTitle)</button>
          </main>
        </body>
        </html>
        """
    }

    private static func htmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
