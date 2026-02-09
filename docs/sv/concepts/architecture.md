---
summary: "WebSocket-gatewayarkitektur, komponenter och klientflöden"
read_when:
  - Arbetar med gateway-protokoll, klienter eller transporter
title: "Gateway-arkitektur"
---

# Gateway-arkitektur

Senast uppdaterad: 2026-01-22

## Översikt

- En enda långlivad **Gateway** äger alla meddelandeytor (WhatsApp via
  Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).
- Kontrollplansklienter (macOS-app, CLI, webb-UI, automationer) ansluter till
  Gateway via **WebSocket** på den konfigurerade bind-värden (standard
  `127.0.0.1:18789`).
- **Noder** (macOS/iOS/Android/headless) ansluter också via **WebSocket**, men
  deklarerar `role: node` med explicita capabiliteter/kommandon.
- En Gateway per värd; det är den enda platsen som öppnar en WhatsApp-session.
- En **canvas-värd** (standard `18793`) serverar agent-redigerbar HTML och A2UI.

## Komponenter och flöden

### Gateway (daemon)

- Upprätthåller leverantörsanslutningar.
- Exponerar ett typat WS-API (förfrågningar, svar, server‑push‑händelser).
- Validerar inkommande ramar mot JSON Schema.
- Sänder händelser som `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Klienter (mac-app / CLI / webbadmin)

- En WS-anslutning per klient.
- Skickar förfrågningar (`health`, `status`, `send`, `agent`, `system-presence`).
- Prenumererar på händelser (`tick`, `agent`, `presence`, `shutdown`).

### Noder (macOS / iOS / Android / headless)

- Ansluter till **samma WS-server** med `role: node`.
- Tillhandahåller en enhetsidentitet i `connect`; parning är **enhetsbaserad** (roll `node`) och
  godkännandet lagras i enhetens parningslager.
- Exponerar kommandon som `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Protokolldetaljer:

- [Gateway-protokoll](/gateway/protocol)

### WebChat

- Statisk UI som använder Gateway WS-API för chattlogg och sändningar.
- I fjärrinstallationer ansluter den via samma SSH-/Tailscale-tunnel som andra
  klienter.

## Anslutningslivscykel (enskild klient)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Trådprotokoll (sammanfattning)

- Transport: WebSocket, textramar med JSON-payloads.
- Första ramen **måste** vara `connect`.
- Efter handskakning:
  - Förfrågningar: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Händelser: `{type:"event", event, payload, seq?, stateVersion?}`
- Om `OPENCLAW_GATEWAY_TOKEN` (eller `--token`) är satt, `connect.params.auth.token`
  måste matcha annars stängs socketen.
- Idempotensnycklar krävs för metoder med sidoeffekter (`send`, `agent`) för
  säker omförsök; servern håller en kortlivad dedupliceringscache.
- Noder måste inkludera `role: "node"` samt capabiliteter/kommandon/behörigheter i `connect`.

## Parning + lokal tillit

- Alla WS-klienter (operatörer + noder) inkluderar en **enhetsidentitet** i `connect`.
- Nya enhets-ID:n kräver parningsgodkännande; Gateway utfärdar en **enhetstoken**
  för efterföljande anslutningar.
- **Lokala** anslutningar (loopback eller gateway-värdens egen tailnet-adress) kan
  auto‑godkännas för att hålla UX smidig på samma värd.
- **Icke‑lokala** anslutningar måste signera `connect.challenge`-nonce och kräver
  explicit godkännande.
- Gateway-autentisering (`gateway.auth.*`) gäller fortfarande för **alla** anslutningar, lokala eller
  fjärranslutna.

Detaljer: [Gateway-protokoll](/gateway/protocol), [Parning](/channels/pairing),
[Säkerhet](/gateway/security).

## Protokolltypning och kodgenerering

- TypeBox-scheman definierar protokollet.
- JSON Schema genereras från dessa scheman.
- Swift-modeller genereras från JSON Schema.

## Fjärråtkomst

- Föredragen: Tailscale eller VPN.

- Alternativ: SSH-tunnel

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Samma handskakning + autentiseringstoken gäller över tunneln.

- TLS + valfri pinning kan aktiveras för WS i fjärrinstallationer.

## Driftöversikt

- Start: `openclaw gateway` (förgrund, loggar till stdout).
- Hälsa: `health` via WS (ingår också i `hello-ok`).
- Övervakning: launchd/systemd för automatisk omstart.

## Invarianter

- Exakt en Gateway kontrollerar en enskild Baileys-session per värd.
- Handskakning är obligatorisk; alla icke‑JSON- eller icke‑connect‑första ramar stänger hårt.
- Händelser spelas inte upp igen; klienter måste uppdatera vid glapp.
