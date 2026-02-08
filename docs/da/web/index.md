---
summary: "Gateway-weboverflader: Control UI, bind-tilstande og sikkerhed"
read_when:
  - Du vil tilgå Gateway over Tailscale
  - Du vil bruge browserens Control UI og redigere konfiguration
title: "Web"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:46Z
---

# Web (Gateway)

Gatewayen leverer en lille **browserbaseret Control UI** (Vite + Lit) fra samme port som Gateway WebSocket:

- standard: `http://<host>:18789/`
- valgfrit præfiks: sæt `gateway.controlUi.basePath` (f.eks. `/openclaw`)

Funktionalitet findes i [Control UI](/web/control-ui).
Denne side fokuserer på bind-tilstande, sikkerhed og webvendte overflader.

## Webhooks

Når `hooks.enabled=true`, eksponerer Gatewayen også et lille webhook-endpoint på samme HTTP-server.
Se [Gateway-konfiguration](/gateway/configuration) → `hooks` for autentificering + payloads.

## Konfiguration (slået til som standard)

Control UI er **aktiveret som standard**, når assets er til stede (`dist/control-ui`).
Du kan styre det via konfiguration:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale-adgang

### Integreret Serve (anbefalet)

Behold Gatewayen på local loopback, og lad Tailscale Serve proxy’e den:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Start derefter gatewayen:

```bash
openclaw gateway
```

Åbn:

- `https://<magicdns>/` (eller din konfigurerede `gateway.controlUi.basePath`)

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

Start derefter gatewayen (token kræves for ikke-loopback binds):

```bash
openclaw gateway
```

Åbn:

- `http://<tailscale-ip>:18789/` (eller din konfigurerede `gateway.controlUi.basePath`)

### Offentligt internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Sikkerhedsnoter

- Gateway-autentificering er påkrævet som standard (token/adgangskode eller Tailscale-identitetsheadere).
- Ikke-loopback binds **kræver** stadig et delt token/adgangskode (`gateway.auth` eller env).
- Opsætningsguiden genererer som standard et gateway-token (selv på loopback).
- UI’et sender `connect.params.auth.token` eller `connect.params.auth.password`.
- Control UI sender anti-clickjacking-headere og accepterer kun same-origin browser-
  websocket-forbindelser, medmindre `gateway.controlUi.allowedOrigins` er sat.
- Med Serve kan Tailscale-identitetsheadere opfylde autentificering, når
  `gateway.auth.allowTailscale` er `true` (ingen token/adgangskode kræves). Sæt
  `gateway.auth.allowTailscale: false` for at kræve eksplicitte legitimationsoplysninger. Se
  [Tailscale](/gateway/tailscale) og [Sikkerhed](/gateway/security).
- `gateway.tailscale.mode: "funnel"` kræver `gateway.auth.mode: "password"` (delt adgangskode).

## Byg UI’et

Gatewayen serverer statiske filer fra `dist/control-ui`. Byg dem med:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
