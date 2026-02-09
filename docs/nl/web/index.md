---
summary: "Gateway-weboppervlakken: Control UI, bind-modi en beveiliging"
read_when:
  - Je wilt toegang tot de Gateway via Tailscale
  - Je wilt de browser-Control UI en configbewerking
title: "Web"
---

# Web (Gateway)

De Gateway levert een kleine **browser Control UI** (Vite + Lit) vanaf dezelfde poort als de Gateway WebSocket:

- standaard: `http://<host>:18789/`
- optionele prefix: stel `gateway.controlUi.basePath` in (bijv. `/openclaw`)

Mogelijkheden staan in [Control UI](/web/control-ui).
Deze pagina richt zich op bind-modi, beveiliging en webgerichte oppervlakken.

## Webhooks

Wanneer `hooks.enabled=true`, stelt de Gateway ook een klein webhook-eindpunt beschikbaar op dezelfde HTTP-server.
Zie [Gateway-configuratie](/gateway/configuration) → `hooks` voor authenticatie + payloads.

## Config (standaard aan)

De Control UI is **standaard ingeschakeld** wanneer assets aanwezig zijn (`dist/control-ui`).
Je kunt dit via de config beheren:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale-toegang

### Integrated Serve (aanbevolen)

Houd de Gateway op local loopback en laat Tailscale Serve deze proxyen:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Start daarna de gateway:

```bash
openclaw gateway
```

Open:

- `https://<magicdns>/` (of je geconfigureerde `gateway.controlUi.basePath`)

### Tailnet-bind + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Start daarna de gateway (token vereist voor niet-loopback binds):

```bash
openclaw gateway
```

Open:

- `http://<tailscale-ip>:18789/` (of je geconfigureerde `gateway.controlUi.basePath`)

### Openbaar internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Beveiligingsnotities

- Gateway-authenticatie is standaard vereist (token/wachtwoord of Tailscale-identiteitsheaders).
- Niet-loopback binds **vereisen** nog steeds een gedeeld token/wachtwoord (`gateway.auth` of env).
- De wizard genereert standaard een gateway-token (zelfs op loopback).
- De UI verzendt `connect.params.auth.token` of `connect.params.auth.password`.
- De Control UI verzendt anti-clickjacking-headers en accepteert alleen same-origin browser-
  websocketverbindingen, tenzij `gateway.controlUi.allowedOrigins` is ingesteld.
- Met Serve kunnen Tailscale-identiteitsheaders authenticatie afhandelen wanneer
  `gateway.auth.allowTailscale` `true` is (geen token/wachtwoord vereist). Stel
  `gateway.auth.allowTailscale: false` in om expliciete inloggegevens te vereisen. Zie
  [Tailscale](/gateway/tailscale) en [Beveiliging](/gateway/security).
- `gateway.tailscale.mode: "funnel"` vereist `gateway.auth.mode: "password"` (gedeeld wachtwoord).

## De UI bouwen

De Gateway levert statische bestanden vanuit `dist/control-ui`. Bouw ze met:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
