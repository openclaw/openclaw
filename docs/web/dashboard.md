---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway dashboard (Control UI) access and auth"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing dashboard authentication or exposure modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Dashboard"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Dashboard (Control UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway dashboard is the browser Control UI served at `/` by default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(override with `gateway.controlUi.basePath`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick open (local Gateway):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key references:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Control UI](/web/control-ui) for usage and UI capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Web surfaces](/web) for bind modes and security notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Authentication is enforced at the WebSocket handshake via `connect.params.auth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security note: the Control UI is an **admin surface** (chat, config, exec approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not expose it publicly. The UI stores the token in `localStorage` after first load.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer localhost, Tailscale Serve, or an SSH tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fast path (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After onboarding, the CLI auto-opens the dashboard and prints a clean (non-tokenized) link.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-open anytime: `openclaw dashboard` (copies link, opens browser if possible, shows SSH hint if headless).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the UI prompts for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Token basics (local vs remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Localhost**: open `http://127.0.0.1:18789/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Token source**: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`); the UI stores a copy in localStorage after you connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Not localhost**: use Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet bind with a token, or an SSH tunnel. See [Web surfaces](/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## If you see “unauthorized” / 1008（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure the gateway is reachable (local: `openclaw status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retrieve the token from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In the dashboard settings, paste the token into the auth field, then connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
