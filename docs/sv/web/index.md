---
summary: "Gatewayns webbgränssnitt: kontroll-UI, bindningslägen och säkerhet"
read_when:
  - Du vill komma åt Gateway via Tailscale
  - Du vill använda webbläsarens kontroll-UI och redigera konfiguration
title: "Webb"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:51Z
---

# Webb (Gateway)

Gatewayn tillhandahåller ett litet **kontroll-UI i webbläsaren** (Vite + Lit) från samma port som Gateway WebSocket:

- standard: `http://<host>:18789/`
- valfri prefix: ställ in `gateway.controlUi.basePath` (t.ex. `/openclaw`)

Funktioner finns i [Control UI](/web/control-ui).
Den här sidan fokuserar på bindningslägen, säkerhet och webbriktade ytor.

## Webhooks

När `hooks.enabled=true`, exponerar Gatewayn även en liten webhook-endpoint på samma HTTP-server.
Se [Gateway-konfiguration](/gateway/configuration) → `hooks` för autentisering + payloads.

## Konfig (på som standard)

Kontroll-UI:t är **aktiverat som standard** när tillgångar finns (`dist/control-ui`).
Du kan styra det via konfiguration:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale-åtkomst

### Integrerad Serve (rekommenderas)

Behåll Gatewayn på local loopback och låt Tailscale Serve proxy den:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Starta sedan gatewayn:

```bash
openclaw gateway
```

Öppna:

- `https://<magicdns>/` (eller din konfigurerade `gateway.controlUi.basePath`)

### Tailnet-bindning + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Starta sedan gatewayn (token krävs för bindningar som inte är loopback):

```bash
openclaw gateway
```

Öppna:

- `http://<tailscale-ip>:18789/` (eller din konfigurerade `gateway.controlUi.basePath`)

### Publika internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Säkerhetsnoteringar

- Gateway-autentisering krävs som standard (token/lösenord eller Tailscale-identitetshuvuden).
- Bindningar som inte är loopback **kräver** fortfarande en delad token/lösenord (`gateway.auth` eller env).
- Guiden genererar som standard en gateway-token (även på loopback).
- UI:t skickar `connect.params.auth.token` eller `connect.params.auth.password`.
- Kontroll-UI:t skickar anti-clickjacking-huvuden och accepterar endast webbläsarens
  websocket-anslutningar från samma ursprung om inte `gateway.controlUi.allowedOrigins` är satt.
- Med Serve kan Tailscale-identitetshuvuden uppfylla autentisering när
  `gateway.auth.allowTailscale` är `true` (ingen token/lösenord krävs). Sätt
  `gateway.auth.allowTailscale: false` för att kräva explicita autentiseringsuppgifter. Se
  [Tailscale](/gateway/tailscale) och [Säkerhet](/gateway/security).
- `gateway.tailscale.mode: "funnel"` kräver `gateway.auth.mode: "password"` (delat lösenord).

## Bygga UI:t

Gatewayn serverar statiska filer från `dist/control-ui`. Bygg dem med:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
