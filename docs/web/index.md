---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway web surfaces: Control UI, bind modes, and security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to access the Gateway over Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the browser Control UI and config editing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Web"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Web (Gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway serves a small **browser Control UI** (Vite + Lit) from the same port as the Gateway WebSocket:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- default: `http://<host>:18789/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Capabilities live in [Control UI](/web/control-ui).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page focuses on bind modes, security, and web-facing surfaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `hooks.enabled=true`, the Gateway also exposes a small webhook endpoint on the same HTTP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Gateway configuration](/gateway/configuration) → `hooks` for auth + payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config (default-on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI is **enabled by default** when assets are present (`dist/control-ui`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can control it via config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tailscale access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Integrated Serve (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep the Gateway on loopback and let Tailscale Serve proxy it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
Then start the gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailnet bind + token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "tailnet",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    controlUi: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: { mode: "token", token: "your-token" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then start the gateway (token required for non-loopback binds):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Public internet (Funnel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "loopback",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tailscale: { mode: "funnel" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway auth is required by default (token/password or Tailscale identity headers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-loopback binds still **require** a shared token/password (`gateway.auth` or env).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The wizard generates a gateway token by default (even on loopback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The UI sends `connect.params.auth.token` or `connect.params.auth.password`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Control UI sends anti-clickjacking headers and only accepts same-origin browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  websocket connections unless `gateway.controlUi.allowedOrigins` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With Serve, Tailscale identity headers can satisfy auth when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `gateway.auth.allowTailscale` is `true` (no token/password required). Set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `gateway.auth.allowTailscale: false` to require explicit credentials. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [Tailscale](/gateway/tailscale) and [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.tailscale.mode: "funnel"` requires `gateway.auth.mode: "password"` (shared password).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Building the UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway serves static files from `dist/control-ui`. Build them with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
