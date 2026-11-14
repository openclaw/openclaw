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
        let buttonClass = signingIn ? "" : "primary"
        var button = """
        <button type="button" class="\(buttonClass)" data-id="\(self.htmlEscape(signedOut.target.bridgeID))"
          onclick="window.webkit.messageHandlers.openclawGateways
            .postMessage({type:'\(action)',id:this.dataset.id})">\(self.htmlEscape(label))</button>
        """
        if signingIn, let browserAttempt {
            let browserLabel = self.htmlEscape(String(localized: "Open browser"))
            button += "\n" + """
            <button type="button" class="primary" data-id="\(self.htmlEscape(signedOut.target.bridgeID))"
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
        title: String, message: String, detail: String?, url: URL?, primaryButton: String? = nil) -> String
    {
        let primaryButton = primaryButton ?? """
        <button type="button" class="primary"
          onclick="window.webkit.messageHandlers.openclawGateways
            .postMessage({type:'reload'})">\(self.htmlEscape(String(localized: "Reload")))</button>
        """
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
            \(Self.styles)
          </style>
        </head>
        <body onmousedown="if (event.button === 0 &amp;&amp; event.target === this) {
          event.preventDefault();
          window.webkit.messageHandlers.openclawWindowDrag.postMessage({type:'window-drag'});
        }">
          <main>
            <div class="badge">!</div>
            <h1>\(self.htmlEscape(title))</h1>
            <p>\(self.htmlEscape(message))</p>
            \(detailHTML)
            \(urlHTML)
            <div class="actions">
              \(primaryButton)
              <button type="button" class="\(primaryButton.isEmpty ? "" : "settings")"
                onclick="window.webkit.messageHandlers.openclawDeviceSettings
                  .postMessage({type:'open',panel:'connection'})">\(connectionTitle)</button>
            </div>
          </main>
        </body>
        </html>
        """
    }

    static func html(removal: MacOpenClawIDRemoval, now: Date = Date()) -> String {
        """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
        \(self.styles)
        :root { --primary: #0067df; --primary-hover: #005bc8; --primary-active: #004fae; --focus-ring: #007aff; }
        main { width: min(900px, calc(100vw - 72px)); padding: 32px; text-align: center;
          background: transparent; border: 0; box-shadow: none; }
        h1 { font-size: 28px; margin-top: 24px; }
        p { line-height: 1.5; }
        .device { width: 64px; height: 64px; color: #8e8e93; }
        .actions { flex-direction: column; margin-top: 32px; gap: 10px; }
        @media (prefers-color-scheme: light) { body { background: #fff; } }
        </style></head><body><main>
        <svg class="device" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"
          aria-hidden="true"><rect x="8" y="8" width="46" height="34" rx="4"/>
          <path d="M3 49h39"/><circle cx="49" cy="43" r="12"/><path d="M42 43h14"/></svg>
        <h1>\(self.htmlEscape(removal.title))</h1>
        <p>\(self.htmlEscape(removal.dashboardMessage(now: now)))</p>
        <div class="actions">
          <button class="primary" onclick="window.webkit.messageHandlers.openclawGateways
            .postMessage({type:'openclaw-id-sign-in'})">Sign in with OpenClaw ID…</button>
          <button class="settings" onclick="window.webkit.messageHandlers.openclawDeviceSettings
            .postMessage({type:'open',panel:'connection'})">Set up a different connection</button>
          <button onclick="window.webkit.messageHandlers.openclawGateways
            .postMessage({type:'close-recovery'})">Close</button>
        </div></main></body></html>
        """
    }

    private static let styles = """
    :root {
      color-scheme: light dark;
      --button-background: rgba(255,255,255,.09);
      --button-border: rgba(255,255,255,.1);
      --button-hover: rgba(255,255,255,.14);
      --button-active: rgba(255,255,255,.06);
      --primary: #d13c3c;
      --primary-hover: #bd3535;
      --primary-active: #a92f2f;
      --focus-ring: #ff746b;
    }
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-top: 24px;
    }
    button {
      appearance: none;
      min-height: 40px;
      padding: 9px 16px;
      border: 1px solid var(--button-border);
      border-radius: 10px;
      background: var(--button-background);
      color: inherit;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      cursor: pointer;
    }
    button:hover { background: var(--button-hover); }
    button:active { background: var(--button-active); }
    button:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 3px; }
    button.primary { background: var(--primary); border-color: transparent; color: #fff; }
    button.primary:hover { background: var(--primary-hover); }
    button.primary:active { background: var(--primary-active); }
    button.settings { background: transparent; border-color: transparent; }
    button.settings:hover { background: var(--button-background); }
    button.settings:active { background: var(--button-active); }
    @media (prefers-color-scheme: light) {
      :root {
        --button-background: rgba(0,0,0,.055);
        --button-border: rgba(0,0,0,.07);
        --button-hover: rgba(0,0,0,.085);
        --button-active: rgba(0,0,0,.12);
        --focus-ring: #bd4531;
      }
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
    """

    private static func htmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
