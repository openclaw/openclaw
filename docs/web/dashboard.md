---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
---

# Dashboard (Control UI)

The Gateway dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, exec approvals).
Do not expose it publicly. The UI keeps dashboard URL tokens in sessionStorage
for the current browser tab session and selected gateway URL, and strips them from the URL after load.
Prefer localhost, Tailscale Serve, or an SSH tunnel.

## Fast path (recommended)

- After onboarding, the CLI auto-opens the dashboard and prints a clean (non-tokenized) link.
- Re-open anytime: `openclaw dashboard` (copies link, opens browser if possible, shows SSH hint if headless).
- If the UI prompts for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.

## Token basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Token source**: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`); `openclaw dashboard` can pass it via URL fragment for one-time bootstrap, and the Control UI keeps it in sessionStorage for the current browser tab session and selected gateway URL instead of localStorage.
- If `gateway.auth.token` is SecretRef-managed, `openclaw dashboard` prints/copies/opens a non-tokenized URL by design. This avoids exposing externally managed tokens in shell logs, clipboard history, or browser-launch arguments.
- If `gateway.auth.token` is configured as a SecretRef and is unresolved in your current shell, `openclaw dashboard` still prints a non-tokenized URL plus actionable auth setup guidance.
- **Not localhost**: use Tailscale Serve (tokenless for Control UI/WebSocket if `gateway.auth.allowTailscale: true`, assumes trusted gateway host; HTTP APIs still need token/password), tailnet bind with a token, or an SSH tunnel. See [Web surfaces](/web).

<a id="if-you-see-unauthorized-1008"></a>

## If you see "unauthorized" / 1008

- Ensure the gateway is reachable (local: `openclaw status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`).
- For `AUTH_TOKEN_MISMATCH`, clients may do one trusted retry with a cached device token when the gateway returns retry hints. If auth still fails after that retry, resolve token drift manually.
- For token drift repair steps, follow [Token drift recovery checklist](/cli/devices#token-drift-recovery-checklist).
- Retrieve or supply the token from the gateway host:
  - Plaintext config: `openclaw config get gateway.auth.token`
  - SecretRef-managed config: resolve the external secret provider or export `OPENCLAW_GATEWAY_TOKEN` in this shell, then rerun `openclaw dashboard`
  - No token configured: `openclaw doctor --generate-gateway-token`
- In the dashboard settings, paste the token into the auth field, then connect.
