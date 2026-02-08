---
summary: "RPC-adaptrar för externa CLI:er (signal-cli, legacy imsg) och gateway-mönster"
read_when:
  - Lägga till eller ändra externa CLI-integrationer
  - Felsöka RPC-adaptrar (signal-cli, imsg)
title: "RPC-adaptrar"
x-i18n:
  source_path: reference/rpc.md
  source_hash: 06dc6b97184cc704
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:18Z
---

# RPC-adaptrar

OpenClaw integrerar externa CLI:er via JSON-RPC. Två mönster används i dag.

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
- Föredra stabila ID:n (t.ex. `chat_id`) framför visningssträngar.
