---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Integrated browser control service + action commands"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding agent-controlled browser automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging why openclaw is interfering with your own Chrome（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing browser settings + lifecycle in the macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Browser (OpenClaw-managed)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Browser (openclaw-managed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is isolated from your personal browser and is managed through a small local（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
control service inside the Gateway (loopback only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Beginner view:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Think of it as a **separate, agent-only browser**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `openclaw` profile does **not** touch your personal browser profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The agent can **open tabs, read pages, click, and type** in a safe lane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The default `chrome` profile uses the **system default Chromium browser** via the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  extension relay; switch to `openclaw` for the isolated managed browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A separate browser profile named **openclaw** (orange accent by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic tab control (list/open/focus/close).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional multi-profile support (`openclaw`, `work`, `remote`, ...).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This browser is **not** your daily driver. It is a safe, isolated surface for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent automation and verification.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw open https://example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you get “Browser disabled”, enable it in config (see below) and restart the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Profiles: `openclaw` vs `chrome`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw`: managed, isolated browser (no extension required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chrome`: extension relay to your **system browser** (requires the OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  extension to be attached to a tab).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `browser.defaultProfile: "openclaw"` if you want managed mode by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browser settings live in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true, // default: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaultProfile: "chrome",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    color: "#FF4500",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    headless: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    noSandbox: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    attachOnly: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profiles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      openclaw: { cdpPort: 18800, color: "#FF4500" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      work: { cdpPort: 18801, color: "#0066CC" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The browser control service binds to loopback on a port derived from `gateway.port`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (default: `18791`, which is gateway + 2). The relay uses the next port (`18792`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you override the Gateway port (`gateway.port` or `OPENCLAW_GATEWAY_PORT`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the derived browser ports shift to stay in the same “family”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cdpUrl` defaults to the relay port when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remoteCdpTimeoutMs` applies to remote (non-loopback) CDP reachability checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remoteCdpHandshakeTimeoutMs` applies to remote CDP WebSocket reachability checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `attachOnly: true` means “never launch a local browser; only attach if it is already running.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `color` + per-profile `color` tint the browser UI so you can see which profile is active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default profile is `chrome` (extension relay). Use `defaultProfile: "openclaw"` for the managed browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-detect order: system default browser if Chromium-based; otherwise Chrome → Brave → Edge → Chromium → Chrome Canary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local `openclaw` profiles auto-assign `cdpPort`/`cdpUrl` — set those only for remote CDP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use Brave (or another Chromium-based browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses it automatically. Set `browser.executablePath` to override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
auto-detection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set browser.executablePath "/usr/bin/google-chrome"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Linux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    executablePath: "/usr/bin/brave-browser"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local vs remote control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local control (default):** the Gateway starts the loopback control service and can launch a local browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote control (node host):** run a node host on the machine that has the browser; the Gateway proxies browser actions to it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote CDP URLs can include auth:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Query tokens (e.g., `https://provider.example?token=<token>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HTTP Basic auth (e.g., `https://user:pass@provider.example`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to the CDP WebSocket. Prefer environment variables or secrets managers for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tokens instead of committing them to config files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node browser proxy (zero-config default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run a **node host** on the machine that has your browser, OpenClaw can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
auto-route browser tool calls to that node without any extra browser config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the default path for remote gateways.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The node host exposes its local browser control server via a **proxy command**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Profiles come from the node’s own `browser.profiles` config (same as local).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable if you don’t want it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - On the node: `nodeHost.browserProxy.enabled=false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - On the gateway: `gateway.nodes.browser.mode="off"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browserless (hosted remote CDP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Browserless](https://browserless.io) is a hosted Chromium service that exposes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CDP endpoints over HTTPS. You can point a OpenClaw browser profile at a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browserless region endpoint and authenticate with your API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaultProfile: "browserless",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remoteCdpTimeoutMs: 2000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remoteCdpHandshakeTimeoutMs: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profiles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      browserless: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        color: "#00AA00",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replace `<BROWSERLESS_API_KEY>` with your real Browserless token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Choose the region endpoint that matches your Browserless account (see their docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key ideas:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser control is loopback-only; access flows through the Gateway’s auth or node pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the Gateway and any node hosts on a private network (Tailscale); avoid public exposure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote CDP tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer HTTPS endpoints and short-lived tokens where possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid embedding long-lived tokens directly in config files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Profiles (multi-browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports multiple named profiles (routing configs). Profiles can be:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **openclaw-managed**: a dedicated Chromium-based browser instance with its own user data directory + CDP port（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **remote**: an explicit CDP URL (Chromium-based browser running elsewhere)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **extension relay**: your existing Chrome tab(s) via the local relay + Chrome extension（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `openclaw` profile is auto-created if missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `chrome` profile is built-in for the Chrome extension relay (points at `http://127.0.0.1:18792` by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local CDP ports allocate from **18800–18899** by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deleting a profile moves its local data directory to Trash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chrome extension relay (use your existing Chrome)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can also drive **your existing Chrome tabs** (no separate “openclaw” Chrome instance) via a local CDP relay + a Chrome extension.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide: [Chrome extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway runs locally (same machine) or a node host runs on the browser machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A local **relay server** listens at a loopback `cdpUrl` (default: `http://127.0.0.1:18792`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You click the **OpenClaw Browser Relay** extension icon on a tab to attach (it does not auto-attach).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The agent controls that tab via the normal `browser` tool, by selecting the right profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs elsewhere, run a node host on the browser machine so the Gateway can proxy browser actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandboxed sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chrome extension relay takeover requires host browser control, so either:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- run the session unsandboxed, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set `agents.defaults.sandbox.browser.allowHostControl: true` and use `target="host"` when calling the tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Load the extension (dev/unpacked):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chrome → `chrome://extensions` → enable “Developer mode”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Load unpacked” → select the directory printed by `openclaw browser extension path`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pin the extension, then click it on the tab you want to control (badge shows `ON`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Use it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw browser --browser-profile chrome tabs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tool: `browser` with `profile="chrome"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional: if you want a different name or relay port, create your own profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser create-profile \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name my-chrome \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --driver extension \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cdp-url http://127.0.0.1:18792 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --color "#00AA00"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This mode relies on Playwright-on-CDP for most operations (screenshots/snapshots/actions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Detach by clicking the extension icon again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Isolation guarantees（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dedicated user data dir**: never touches your personal browser profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Deterministic tab control**: target tabs by `targetId`, not “last tab”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When launching locally, OpenClaw picks the first available:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Chrome（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Brave（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Edge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Chromium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Chrome Canary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override with `browser.executablePath`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Platforms:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: checks `/Applications` and `~/Applications`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux: looks for `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: checks common install locations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Control API (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For local integrations only, the Gateway exposes a small loopback HTTP API:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status/start/stop: `GET /`, `POST /start`, `POST /stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Actions: `POST /navigate`, `POST /act`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloads: `POST /download`, `POST /wait/download`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debugging: `GET /console`, `POST /pdf`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Network: `POST /response/body`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All endpoints accept `?profile=<name>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Playwright requirement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some features (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) require（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Playwright. If Playwright isn’t installed, those endpoints return a clear 501（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
error. ARIA snapshots and basic screenshots still work for openclaw-managed Chrome.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the Chrome extension relay driver, ARIA snapshots and screenshots require Playwright.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see `Playwright is not available in this gateway build`, install the full（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Playwright package (not `playwright-core`) and restart the gateway, or reinstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw with browser support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Docker Playwright install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your Gateway runs in Docker, avoid `npx playwright` (npm override conflicts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the bundled CLI instead:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  node /app/node_modules/playwright-core/cli.js install chromium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To persist browser downloads, set `PLAYWRIGHT_BROWSERS_PATH` (for example,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/home/node/.cache/ms-playwright`) and make sure `/home/node` is persisted via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_HOME_VOLUME` or a bind mount. See [Docker](/install/docker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (internal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
High-level flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A small **control server** accepts HTTP requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- It connects to Chromium-based browsers (Chrome/Brave/Edge/Chromium) via **CDP**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For advanced actions (click/type/snapshot/PDF), it uses **Playwright** on top（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  of CDP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When Playwright is missing, only non-Playwright operations are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This design keeps the agent on a stable, deterministic interface while letting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you swap local/remote browsers and profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI quick reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All commands accept `--browser-profile <name>` to target a specific profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All commands also accept `--json` for machine-readable output (stable payloads).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Basics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser tabs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser tab`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser tab new`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser tab select 2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser tab close 2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser open https://example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser focus abcd1234`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser close abcd1234`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inspection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser screenshot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser screenshot --full-page`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser screenshot --ref 12`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser screenshot --ref e12`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --format aria --limit 200`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --interactive --compact --depth 6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --efficient`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --labels`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --selector "#main" --interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser snapshot --frame "iframe#main" --interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser console --level error`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser errors --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser requests --filter api --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser pdf`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser responsebody "**/api" --max-chars 5000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser navigate https://example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser resize 1280 720`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser click 12 --double`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser click e12 --double`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser type 23 "hello" --submit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser press Enter`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser hover 44`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser scrollintoview e12`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser drag 10 11`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser select 9 OptionA OptionB`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser download e12 /tmp/report.pdf`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser waitfordownload /tmp/report.pdf`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser upload /tmp/file.pdf`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser dialog --accept`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser wait --text "Done"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser highlight e12`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser trace start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser trace stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
State:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser cookies`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser cookies set session abc123 --url "https://example.com"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser cookies clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser storage local get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser storage local set theme dark`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser storage session clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set offline on`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set headers --json '{"X-Debug":"1"}'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set credentials user pass`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set credentials --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set geo --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set media dark`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set timezone America/New_York`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set locale en-US`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw browser set device "iPhone 14"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `upload` and `dialog` are **arming** calls; run them before the click/press（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  that triggers the chooser/dialog.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `upload` can also set file inputs directly via `--input-ref` or `--element`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `snapshot`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--format ai` (default when Playwright is installed): returns an AI snapshot with numeric refs (`aria-ref="<n>"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--format aria`: returns the accessibility tree (no refs; inspection only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--efficient` (or `--mode efficient`): compact role snapshot preset (interactive + compact + depth + lower maxChars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Config default (tool/CLI only): set `browser.snapshotDefaults.mode: "efficient"` to use efficient snapshots when the caller does not pass a mode (see [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Role snapshot options (`--interactive`, `--compact`, `--depth`, `--selector`) force a role-based snapshot with refs like `ref=e12`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--frame "<iframe selector>"` scopes role snapshots to an iframe (pairs with role refs like `e12`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--interactive` outputs a flat, easy-to-pick list of interactive elements (best for driving actions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--labels` adds a viewport-only screenshot with overlayed ref labels (prints `MEDIA:<path>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `click`/`type`/etc require a `ref` from `snapshot` (either numeric `12` or role ref `e12`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  CSS selectors are intentionally not supported for actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Snapshots and refs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports two “snapshot” styles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **AI snapshot (numeric refs)**: `openclaw browser snapshot` (default; `--format ai`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Output: a text snapshot that includes numeric refs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Actions: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Internally, the ref is resolved via Playwright’s `aria-ref`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Role snapshot (role refs like `e12`)**: `openclaw browser snapshot --interactive` (or `--compact`, `--depth`, `--selector`, `--frame`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Output: a role-based list/tree with `[ref=e12]` (and optional `[nth=1]`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Actions: `openclaw browser click e12`, `openclaw browser highlight e12`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Internally, the ref is resolved via `getByRole(...)` (plus `nth()` for duplicates).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Add `--labels` to include a viewport screenshot with overlayed `e12` labels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ref behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Refs are **not stable across navigations**; if something fails, re-run `snapshot` and use a fresh ref.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the role snapshot was taken with `--frame`, role refs are scoped to that iframe until the next role snapshot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Wait power-ups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can wait on more than just time/text:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wait for URL (globs supported by Playwright):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw browser wait --url "**/dash"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wait for load state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw browser wait --load networkidle`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wait for a JS predicate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw browser wait --fn "window.ready===true"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wait for a selector to become visible:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw browser wait "#main"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These can be combined:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser wait "#main" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --url "**/dash" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --load networkidle \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --fn "window.ready===true" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --timeout-ms 15000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debug workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When an action fails (e.g. “not visible”, “strict mode violation”, “covered”):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `openclaw browser snapshot --interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Use `click <ref>` / `type <ref>` (prefer role refs in interactive mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If it still fails: `openclaw browser highlight <ref>` to see what Playwright is targeting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If the page behaves oddly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw browser errors --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw browser requests --filter api --clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. For deep debugging: record a trace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw browser trace start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - reproduce the issue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw browser trace stop` (prints `TRACE:<path>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--json` is for scripting and structured tooling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser status --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser snapshot --interactive --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser requests --filter api --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser cookies --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Role snapshots in JSON include `refs` plus a small `stats` block (lines/chars/refs/interactive) so tools can reason about payload size and density.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## State and environment knobs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are useful for “make the site behave like X” workflows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cookies: `cookies`, `cookies set`, `cookies clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Storage: `storage local|session get|set|clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Offline: `set offline on|off`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Headers: `set headers --json '{"X-Debug":"1"}'` (or `--clear`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HTTP basic auth: `set credentials user pass` (or `--clear`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (or `--clear`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: `set media dark|light|no-preference|none`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Timezone / locale: `set timezone ...`, `set locale ...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Device / viewport:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `set device "iPhone 14"` (Playwright device presets)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `set viewport 1280 720`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security & privacy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The openclaw browser profile may contain logged-in sessions; treat it as sensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser act kind=evaluate` / `openclaw browser evaluate` and `wait --fn`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execute arbitrary JavaScript in the page context. Prompt injection can steer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  this. Disable it with `browser.evaluateEnabled=false` if you do not need it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For logins and anti-bot notes (X/Twitter, etc.), see [Browser login + X/Twitter posting](/tools/browser-login).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the Gateway/node host private (loopback or tailnet-only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote CDP endpoints are powerful; tunnel and protect them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For Linux-specific issues (especially snap Chromium), see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Browser troubleshooting](/tools/browser-linux-troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent tools + how control works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent gets **one tool** for browser automation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
How it maps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser snapshot` returns a stable UI tree (AI or ARIA).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser act` uses the snapshot `ref` IDs to click/type/drag/select.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser screenshot` captures pixels (full page or element).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser` accepts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `profile` to choose a named browser profile (openclaw, chrome, or remote CDP).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `target` (`sandbox` | `host` | `node`) to select where the browser lives.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - In sandboxed sessions, `target: "host"` requires `agents.defaults.sandbox.browser.allowHostControl=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If `target` is omitted: sandboxed sessions default to `sandbox`, non-sandbox sessions default to `host`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If a browser-capable node is connected, the tool may auto-route to it unless you pin `target="host"` or `target="node"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps the agent deterministic and avoids brittle selectors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
