---
summary: "Local versus remote control, the node browser proxy, and hosted CDP providers"
title: "Remote and hosted browsers"
read_when:
  - The browser runs on a different machine from the Gateway
  - You are attaching to Browserless, Browserbase, or Notte
  - You need the accepted CDP URL shapes
---

## Local vs remote control

- **Local control (default):** the Gateway starts the loopback control service and can launch a local browser.
  Targetless actions can launch it (for example, `open`, `navigate`, or `openclaw browser start`). Actions that name a
  tab by `targetId`, tab id, or label never start a stopped browser, because a new browser cannot
  contain that tab; start the browser or open a new tab, then select a current target.
- **Remote control (node host):** run a node host on the machine that has the browser; the Gateway proxies browser actions to it.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.
- For externally managed CDP services on loopback (for example Browserless in
  Docker published to `127.0.0.1`), also set `attachOnly: true`. Loopback CDP
  without `attachOnly` is treated as a local OpenClaw-managed browser profile.
- `headless` only affects local managed profiles that OpenClaw launches. It does not restart or change existing-session or remote CDP browsers.
- `executablePath` follows the same local managed profile rule. Changing it on a
  running local managed profile marks that profile for restart/reconcile so the
  next launch uses the new binary.

Stopping behavior differs by profile mode:

- local managed profiles: `openclaw browser stop` stops the browser process that
  OpenClaw launched
- attach-only and remote CDP profiles: `openclaw browser stop` closes the active
  control session and releases Playwright/CDP emulation overrides (viewport,
  color scheme, locale, timezone, offline mode, and similar state), even
  though no browser process was launched by OpenClaw

Remote CDP URLs can include auth:

- Query tokens (e.g., `https://provider.example?token=<token>`)
- HTTP Basic auth (e.g., `https://user:pass@provider.example`)

OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting
to the CDP WebSocket. Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node browser proxy (zero-config default)

If you run a **node host** on the machine that has your browser, OpenClaw can
auto-route browser tool calls to that node without any extra browser config.
This is the default path for remote gateways. Automatic host fallback is allowed
only before the selected node handles a request. Once an action reaches the node,
its follow-up snapshot or settings stay on that node instead of switching browsers.

Standalone runs such as `openclaw agent exec` use the host browser when no
Gateway or node route is selected. They do not need Gateway credentials for
local browser control. Sandbox routing and host-control restrictions still apply.
To discover browser nodes through a local Gateway from a standalone run, set
`gateway.nodes.browser.mode="auto"`. An explicit node target or pin, remote
Gateway configuration, or `OPENCLAW_GATEWAY_URL` also keeps node discovery
enabled. Explicit node targets and pins retain connection and authentication
errors.

Notes:

- The node host exposes its local browser control server via a **proxy command**.
- Profiles come from the node's own `browser.profiles` config (same as local).
- The proxy command never allows persistent profile mutations (`create-profile`, `delete-profile`, `reset-profile`) regardless of `allowProfiles`; make those changes on the node directly.
- `nodeHost.browserProxy.allowProfiles` is optional. Leave it empty for the legacy/default behavior: all configured profiles remain reachable through the proxy.
- If you set `nodeHost.browserProxy.allowProfiles`, OpenClaw treats it as a least-privilege boundary limiting which profile names the proxy will target.
- Disable if you don't want it:
  - On the node: `nodeHost.browserProxy.enabled=false`
  - On the gateway: `gateway.nodes.browser.mode="off"` (also accepts `"auto"` to pick a single connected browser node, or `"manual"` to require an explicit node param)

## Browserless (hosted remote CDP)

[Browserless](https://browserless.io) is a hosted Chromium service that exposes
CDP connection URLs over HTTPS and WebSocket. OpenClaw can use either form, but
for a remote browser profile the simplest option is the direct WebSocket URL
from Browserless' connection docs.

Example:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    profiles: {
      browserless: {
        cdpUrl: "wss://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
      },
    },
  },
}
```

Notes:

- Replace `<BROWSERLESS_API_KEY>` with your real Browserless token.
- Choose the region endpoint that matches your Browserless account (see their docs).
- If Browserless gives you an HTTPS base URL, you can either convert it to
  `wss://` for a direct CDP connection or keep the HTTPS URL and let OpenClaw
  discover `/json/version`.

### Browserless Docker on the same host

When Browserless is self-hosted in Docker and OpenClaw runs on the host, treat
Browserless as an externally managed CDP service:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    profiles: {
      browserless: {
        cdpUrl: "ws://127.0.0.1:3000",
        attachOnly: true,
      },
    },
  },
}
```

The address in `browser.profiles.browserless.cdpUrl` must be reachable from the
OpenClaw process. Browserless must also advertise a matching reachable endpoint;
set Browserless `EXTERNAL` to that same public-to-OpenClaw WebSocket base, such
as `ws://127.0.0.1:3000`, `ws://browserless:3000`, or a stable private Docker
network address. If `/json/version` returns `webSocketDebuggerUrl` pointing at
an address OpenClaw cannot reach, CDP HTTP can look healthy while the WebSocket
attach still fails.

Do not leave `attachOnly` unset for a loopback Browserless profile. Without
`attachOnly`, OpenClaw treats the loopback port as a local managed browser
profile and may report that the port is in use but not owned by OpenClaw.

## Direct WebSocket CDP providers

Some hosted browser services expose a **direct WebSocket** endpoint rather than
the standard HTTP-based CDP discovery (`/json/version`). OpenClaw accepts three
CDP URL shapes and picks the right connection strategy automatically:

- **HTTP(S) discovery** - `http://host[:port]` or `https://host[:port]`.
  OpenClaw calls `/json/version` to discover the WebSocket debugger URL, then
  connects. No WebSocket fallback.
- **Direct WebSocket endpoints** - `ws://host[:port]/devtools/<kind>/<id>` or
  `wss://...` with a `/devtools/browser|page|worker|shared_worker|service_worker/<id>`
  path. OpenClaw connects directly via a WebSocket handshake and skips
  `/json/version` entirely.
- **Bare WebSocket roots** - `ws://host[:port]` or `wss://host[:port]` with no
  `/devtools/...` path (e.g. [Browserless](https://browserless.io),
  [Browserbase](https://www.browserbase.com)). OpenClaw tries HTTP
  `/json/version` discovery first (normalising the scheme to `http`/`https`);
  if discovery returns a `webSocketDebuggerUrl` it is used, otherwise OpenClaw
  falls back to a direct WebSocket handshake at the bare root. If the advertised
  WebSocket endpoint rejects the CDP handshake but the configured bare root
  accepts it, OpenClaw falls back to that root as well. This lets a bare `ws://`
  pointed at a local Chrome still connect, since Chrome only accepts WebSocket
  upgrades on the specific per-target path from `/json/version`, while hosted
  providers can still use their root WebSocket endpoint when their discovery
  endpoint advertises a short-lived URL that is not suitable for Playwright CDP.

`openclaw browser doctor` uses the same discovery-first, WebSocket-fallback
logic as runtime attach, so a bare-root URL that connects successfully is not
reported as unreachable by diagnostics.

### Browserbase

[Browserbase](https://www.browserbase.com) is a cloud platform for running
headless browsers with built-in CAPTCHA solving, stealth mode, and residential
proxies.

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    profiles: {
      browserbase: {
        cdpUrl: "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>",
      },
    },
  },
}
```

Notes:

- [Sign up](https://www.browserbase.com/sign-up) and copy your **API Key**
  from the [Overview dashboard](https://www.browserbase.com/overview).
- Replace `<BROWSERBASE_API_KEY>` with your real Browserbase API key.
- Browserbase auto-creates a browser session on WebSocket connect, so no
  manual session creation step is needed.
- See [pricing](https://www.browserbase.com/pricing) for current free-tier limits and paid plans.
- See the [Browserbase docs](https://docs.browserbase.com) for full API
  reference, SDK guides, and integration examples.

### Notte

[Notte](https://www.notte.cc) is a cloud platform for running headless
browsers with built-in stealth, residential proxies, and a CDP-native
WebSocket gateway.

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "notte",
    profiles: {
      notte: {
        cdpUrl: "wss://us-prod.notte.cc/sessions/connect?token=<NOTTE_API_KEY>",
      },
    },
  },
}
```

Notes:

- [Sign up](https://console.notte.cc) and copy your **API Key** from the
  console settings page.
- Replace `<NOTTE_API_KEY>` with your real Notte API key.
- Notte auto-creates a browser session on WebSocket connect, so no manual
  session creation step is needed. The session is destroyed when the
  WebSocket disconnects.
- See [pricing](https://www.notte.cc/#pricing) for current free-tier limits and paid plans.
- See the [Notte docs](https://docs.notte.cc) for full API reference, SDK
  guides, and integration examples.
