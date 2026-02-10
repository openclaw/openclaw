---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to operate the Gateway from a browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Tailnet access without SSH tunnels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Control UI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Control UI (browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI is a small **Vite + Lit** single-page app served by the Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- default: `http://<host>:18789/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It speaks **directly to the Gateway WebSocket** on the same port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick open (local)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is running on the same computer, open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the page fails to load, start the Gateway first: `openclaw gateway`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth is supplied during the WebSocket handshake via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `connect.params.auth.token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `connect.params.auth.password`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The dashboard settings panel lets you store a token; passwords are not persisted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The onboarding wizard generates a gateway token by default, so paste it here on first connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Device pairing (first connection)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you connect to the Control UI from a new browser or device, the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires a **one-time pairing approval** — even if you're on the same Tailnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with `gateway.auth.allowTailscale: true`. This is a security measure to prevent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unauthorized access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What you'll see:** "disconnected (1008): pairing required"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**To approve the device:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# List pending requests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Approve by request ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once approved, the device is remembered and won't require re-approval unless（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you revoke it with `openclaw devices revoke --device <id> --role <role>`. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Devices CLI](/cli/devices) for token rotation and revocation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Notes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local connections (`127.0.0.1`) are auto-approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote connections (LAN, Tailnet, etc.) require explicit approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each browser profile generates a unique device ID, so switching browsers or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  clearing browser data will require re-pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it can do (today)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stream tool calls + live tool output cards in Chat (agent events)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: WhatsApp/Telegram/Discord/Slack + plugin channels (Mattermost, etc.) status + QR login + per-channel config (`channels.status`, `web.login.*`, `config.patch`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Instances: presence list + refresh (`system-presence`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: list + per-session thinking/verbose overrides (`sessions.list`, `sessions.patch`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron jobs: list/add/run/enable/disable + run history (`cron.*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: status, enable/disable, install, API key updates (`skills.*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes: list + caps (`node.list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: edit gateway or node allowlists + ask policy for `exec host=gateway/node` (`exec.approvals.*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: view/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: apply + restart with validation (`config.apply`) and wake the last active session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config writes include a base-hash guard to prevent clobbering concurrent edits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config schema + form rendering (`config.schema`, including plugin + channel schemas); Raw JSON editor remains available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debug: status/health/models snapshots + event log + manual RPC calls (`status`, `health`, `models.list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update: run a package/git update + restart (`update.run`) with a restart report（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron jobs panel notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For isolated jobs, delivery defaults to announce summary. You can switch to none if you want internal-only runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel/target fields appear when announce is selected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat.inject` appends an assistant note to the session transcript and broadcasts a `chat` event for UI-only updates (no agent run, no channel delivery).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stop:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Click **Stop** (calls `chat.abort`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Type `/stop` (or `stop|esc|abort|wait|exit|interrupt`) to abort out-of-band（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tailnet access (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Integrated Tailscale Serve (preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --tailscale serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Serve requests can authenticate via Tailscale identity headers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
verifies the identity by resolving the `x-forwarded-for` address with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tailscale whois` and matching it to the header, and only accepts these when the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
request hits loopback with Tailscale’s `x-forwarded-*` headers. Set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway.auth.allowTailscale: false` (or force `gateway.auth.mode: "password"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if you want to require a token/password even for Serve traffic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bind to tailnet + token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste the token into the UI settings (sent as `connect.params.auth.token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Insecure HTTP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the browser runs in a **non-secure context** and blocks WebCrypto. By default,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw **blocks** Control UI connections without device identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `https://<magicdns>/` (Serve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `http://127.0.0.1:18789/` (on the gateway host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Downgrade example (token-only over HTTP):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    controlUi: { allowInsecureAuth: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "tailnet",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: { mode: "token", token: "replace-me" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This disables device identity + pairing for the Control UI (even on HTTPS). Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
only if you trust the network.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Building the UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway serves static files from `dist/control-ui`. Build them with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional absolute base (when you want fixed asset URLs):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For local development (separate dev server):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:dev # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging/testing: dev server + remote Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI is static files; the WebSocket target is configurable and can be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
different from the HTTP origin. This is handy when you want the Vite dev server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
locally but the Gateway runs elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the UI dev server: `pnpm ui:dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Open a URL like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional one-time auth (if needed):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayUrl` is stored in localStorage after load and removed from the URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `token` is stored in localStorage; `password` is kept in memory only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gatewayUrl` is set, the UI does not fall back to config or environment credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Provide `token` (or `password`) explicitly. Missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayUrl` is only accepted in a top-level window (not embedded) to prevent clickjacking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For cross-origin dev setups (e.g. `pnpm ui:dev` to a remote Gateway), add the UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  origin to `gateway.controlUi.allowedOrigins`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    controlUi: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowedOrigins: ["http://localhost:5173"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote access setup details: [Remote access](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
