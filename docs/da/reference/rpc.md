---
summary: "RPC-adaptere til eksterne CLI’er (signal-cli, legacy imsg) og gateway-mønstre"
read_when:
  - Tilføjelse eller ændring af eksterne CLI-integrationer
  - Fejlfinding af RPC-adaptere (signal-cli, imsg)
title: "RPC-adaptere"
---

# RPC-adaptere

OpenClaw integrerer eksterne CLIs via JSON-RPC. Der anvendes to mønstre i dag.

## Mønster A: HTTP-daemon (signal-cli)

- `signal-cli` kører som en daemon med JSON-RPC over HTTP.
- Event-stream er SSE (`/api/v1/events`).
- Health probe: `/api/v1/check`.
- OpenClaw ejer livscyklussen, når `channels.signal.autoStart=true`.

Se [Signal](/channels/signal) for opsætning og endpoints.

## Mønster B: stdio-underproces (legacy: imsg)

> **Note:** Til nye iMessage-opsætninger skal du i stedet bruge [BlueBubbles](/channels/bluebubbles).

- OpenClaw starter `imsg rpc` som en underproces (legacy iMessage-integration).
- JSON-RPC er linjeafgrænset over stdin/stdout (ét JSON-objekt pr. linje).
- Ingen TCP-port, ingen daemon påkrævet.

Kernemetoder, der bruges:

- `watch.subscribe` → notifikationer (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostik)

Se [iMessage](/channels/imessage) for legacy-opsætning og adressering (`chat_id` foretrækkes).

## Retningslinjer for adaptere

- Gateway ejer processen (start/stop er knyttet til udbyderens livscyklus).
- Hold RPC-klienter robuste: timeouts, genstart ved exit.
- Foretræk stabile id'er (f.eks.`chat_id`) over visningsstrenge.
