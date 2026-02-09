---
summary: "RPC-adapters voor externe CLI's (signal-cli, legacy imsg) en gateway-patronen"
read_when:
  - Externe CLI-integraties toevoegen of wijzigen
  - RPC-adapters debuggen (signal-cli, imsg)
title: "RPC-adapters"
---

# RPC-adapters

OpenClaw integreert externe CLI's via JSON-RPC. Tegenwoordig worden twee patronen gebruikt.

## Patroon A: HTTP-daemon (signal-cli)

- `signal-cli` draait als een daemon met JSON-RPC over HTTP.
- Eventstream is SSE (`/api/v1/events`).
- Health probe: `/api/v1/check`.
- OpenClaw beheert de lifecycle wanneer `channels.signal.autoStart=true`.

Zie [Signal](/channels/signal) voor installatie en endpoints.

## Patroon B: stdio childproces (legacy: imsg)

> **Let op:** Gebruik voor nieuwe iMessage-installaties in plaats daarvan [BlueBubbles](/channels/bluebubbles).

- OpenClaw start `imsg rpc` als een childproces (legacy iMessage-integratie).
- JSON-RPC is regelgescheiden over stdin/stdout (één JSON-object per regel).
- Geen TCP-poort, geen daemon vereist.

Gebruikte kernmethoden:

- `watch.subscribe` → notificaties (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostiek)

Zie [iMessage](/channels/imessage) voor legacy installatie en adressering (`chat_id` heeft de voorkeur).

## Richtlijnen voor adapters

- Gateway beheert het proces (start/stop gekoppeld aan de provider-lifecycle).
- Houd RPC-clients robuust: time-outs, herstart bij beëindigen.
- Geef de voorkeur aan stabiele ID's (bijv. `chat_id`) boven weergavestrings.
