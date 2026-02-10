---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Integrated Tailscale Serve/Funnel for the Gateway dashboard"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Exposing the Gateway Control UI outside localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Automating tailnet or public dashboard access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Tailscale"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Tailscale (Gateway dashboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway dashboard and WebSocket port. This keeps the Gateway bound to loopback while（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tailscale provides HTTPS, routing, and (for Serve) identity headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `funnel`: Public HTTPS via `tailscale funnel`. OpenClaw requires a shared password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: Default (no Tailscale automation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.auth.mode` to control the handshake:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `token` (default when `OPENCLAW_GATEWAY_TOKEN` is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `password` (shared secret via `OPENCLAW_GATEWAY_PASSWORD` or config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
valid Serve proxy requests can authenticate via Tailscale identity headers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`tailscale-user-login`) without supplying a token/password. OpenClaw verifies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the identity by resolving the `x-forwarded-for` address via the local Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
daemon (`tailscale whois`) and matching it to the header before accepting it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw only treats a request as Serve when it arrives from loopback with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tailscale’s `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To require explicit credentials, set `gateway.auth.allowTailscale: false` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
force `gateway.auth.mode: "password"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailnet-only (Serve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "loopback",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tailscale: { mode: "serve" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open: `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailnet-only (bind to Tailnet IP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when you want the Gateway to listen directly on the Tailnet IP (no Serve/Funnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "tailnet",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: { mode: "token", token: "your-token" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Connect from another Tailnet device:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: `http://<tailscale-ip>:18789/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebSocket: `ws://<tailscale-ip>:18789`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: loopback (`http://127.0.0.1:18789`) will **not** work in this mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Public internet (Funnel + shared password)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "loopback",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tailscale: { mode: "funnel" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: { mode: "password", password: "replace-me" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer `OPENCLAW_GATEWAY_PASSWORD` over committing a password to disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --tailscale serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --tailscale funnel --auth password（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale Serve/Funnel requires the `tailscale` CLI to be installed and logged in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailscale.mode: "funnel"` refuses to start unless auth mode is `password` to avoid public exposure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `gateway.tailscale.resetOnExit` if you want OpenClaw to undo `tailscale serve`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or `tailscale funnel` configuration on shutdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.bind: "tailnet"` is a direct Tailnet bind (no HTTPS, no Serve/Funnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.bind: "auto"` prefers loopback; use `tailnet` if you want Tailnet-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the same Gateway WS endpoint, so Serve can work for node access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser control (remote Gateway + local browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run the Gateway on one machine but want to drive a browser on another machine,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
run a **node host** on the browser machine and keep both on the same tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway will proxy browser actions to the node; no separate control server or Serve URL needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid Funnel for browser control; treat node pairing like operator access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tailscale prerequisites + limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Serve requires HTTPS enabled for your tailnet; the CLI prompts if it is missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Serve injects Tailscale identity headers; Funnel does not.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Funnel requires Tailscale v1.38.3+, MagicDNS, HTTPS enabled, and a funnel node attribute.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Funnel only supports ports `443`, `8443`, and `10000` over TLS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Funnel on macOS requires the open-source Tailscale app variant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Learn more（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale Serve overview: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale Funnel overview: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
