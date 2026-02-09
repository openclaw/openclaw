---
summary: "RPC-adaptrar för externa CLI:er (signal-cli, legacy imsg) och gateway-mönster"
read_when:
  - Lägga till eller ändra externa CLI-integrationer
  - Felsöka RPC-adaptrar (signal-cli, imsg)
title: "RPC-adaptrar"
---

# RPC-adaptrar

OpenClaw integrerar externa CLIs via JSON-RPC. Två mönster används idag.

## Mönster A: HTTP-daemon (signal-cli)

- `signal-cli` körs som en daemon med JSON-RPC över HTTP.
- Händelseströmmen är SSE (`/api/v1/events`).
- Hälsokontroll: `/api/v1/check`.
- OpenClaw äger livscykeln när `channels.signal.autoStart=true`.

Se [Signal](/channels/signal) för konfigurering och endpoints.

## Mönster B: stdio-barnprocess (legacy: imsg)

> **Obs:** För nya iMessage-konfigurationer, använd [BlueBubbles](/channels/bluebubbles) i stället.

- OpenClaw startar `imsg rpc` som en barnprocess (legacy iMessage-integration).
- JSON-RPC är radavgränsad över stdin/stdout (ett JSON-objekt per rad).
- Ingen TCP-port, ingen daemon krävs.

Kärnmetoder som används:

- `watch.subscribe` → notiser (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (prob/diagnostik)

Se [iMessage](/channels/imessage) för legacy-konfigurering och adressering (`chat_id` föredras).

## Riktlinjer för adaptrar

- Gateway äger processen (start/stopp knutet till leverantörens livscykel).
- Håll RPC-klienter robusta: tidsgränser, starta om vid avslut.
- Föredrar stabila ID (t.ex., `chat_id`) över visningssträngar.
