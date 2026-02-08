---
summary: "Mga web surface ng Gateway: Control UI, mga bind mode, at seguridad"
read_when:
  - Gusto mong i-access ang Gateway sa pamamagitan ng Tailscale
  - Gusto mo ang Control UI sa browser at pag-edit ng config
title: "Web"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:58Z
---

# Web (Gateway)

Ang Gateway ay naghahain ng maliit na **browser Control UI** (Vite + Lit) mula sa parehong port gaya ng Gateway WebSocket:

- default: `http://<host>:18789/`
- opsyonal na prefix: itakda ang `gateway.controlUi.basePath` (hal. `/openclaw`)

Makikita ang mga kakayahan sa [Control UI](/web/control-ui).
Nakatuon ang pahinang ito sa mga bind mode, seguridad, at mga web-facing na surface.

## Webhooks

Kapag `hooks.enabled=true`, nag-e-expose din ang Gateway ng maliit na webhook endpoint sa parehong HTTP server.
Tingnan ang [Gateway configuration](/gateway/configuration) → `hooks` para sa auth + mga payload.

## Config (default-on)

Ang Control UI ay **naka-enable bilang default** kapag naroroon ang mga asset (`dist/control-ui`).
Maaari mo itong kontrolin sa pamamagitan ng config:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale access

### Integrated Serve (inirerekomenda)

Panatilihin ang Gateway sa loopback at ipa-proxy ito gamit ang Tailscale Serve:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Pagkatapos ay simulan ang gateway:

```bash
openclaw gateway
```

Buksan:

- `https://<magicdns>/` (o ang naka-configure mong `gateway.controlUi.basePath`)

### Tailnet bind + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Pagkatapos ay simulan ang gateway (kailangan ang token para sa mga non-loopback bind):

```bash
openclaw gateway
```

Buksan:

- `http://<tailscale-ip>:18789/` (o ang naka-configure mong `gateway.controlUi.basePath`)

### Pampublikong internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Mga tala sa seguridad

- Kinakailangan ang Gateway auth bilang default (token/password o mga Tailscale identity header).
- Ang mga non-loopback bind ay **nangangailangan** pa rin ng shared token/password (`gateway.auth` o env).
- Ang wizard ay gumagawa ng gateway token bilang default (kahit sa loopback).
- Ang UI ay nagpapadala ng `connect.params.auth.token` o `connect.params.auth.password`.
- Ang Control UI ay nagpapadala ng mga anti-clickjacking header at tumatanggap lamang ng mga same-origin na koneksyon ng browser websocket maliban kung nakatakda ang `gateway.controlUi.allowedOrigins`.
- Kapag may Serve, maaaring masapat ang mga Tailscale identity header para sa auth kapag ang
  `gateway.auth.allowTailscale` ay `true` (walang token/password na kailangan). Itakda ang
  `gateway.auth.allowTailscale: false` para mangailangan ng tahasang kredensyal. Tingnan ang
  [Tailscale](/gateway/tailscale) at [Security](/gateway/security).
- Ang `gateway.tailscale.mode: "funnel"` ay nangangailangan ng `gateway.auth.mode: "password"` (shared password).

## Pagbuo ng UI

Naghahain ang Gateway ng mga static file mula sa `dist/control-ui`. I-build ang mga ito gamit ang:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
