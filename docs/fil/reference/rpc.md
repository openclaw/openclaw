---
summary: "Mga RPC adapter para sa mga external CLI (signal-cli, legacy imsg) at mga pattern ng gateway"
read_when:
  - Pagdaragdag o pagbabago ng mga external na integrasyon ng CLI
  - Pag-debug ng mga RPC adapter (signal-cli, imsg)
title: "Mga RPC Adapter"
---

# Mga RPC adapter

OpenClaw integrates external CLIs via JSON-RPC. Two patterns are used today.

## Pattern A: HTTP daemon (signal-cli)

- Ang `signal-cli` ay tumatakbo bilang daemon na may JSON-RPC sa ibabaw ng HTTP.
- Ang event stream ay SSE (`/api/v1/events`).
- Health probe: `/api/v1/check`.
- Hawak ng OpenClaw ang lifecycle kapag `channels.signal.autoStart=true`.

Tingnan ang [Signal](/channels/signal) para sa setup at mga endpoint.

## Pattern B: stdio child process (legacy: imsg)

> **Note:** Para sa mga bagong iMessage setup, gamitin ang [BlueBubbles](/channels/bluebubbles) sa halip.

- Nag-i-spawn ang OpenClaw ng `imsg rpc` bilang child process (legacy na integrasyon ng iMessage).
- Ang JSON-RPC ay line-delimited sa stdin/stdout (isang JSON object bawat linya).
- Walang TCP port, hindi kailangan ng daemon.

Mga core method na ginagamit:

- `watch.subscribe` → mga notification (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostics)

Tingnan ang [iMessage](/channels/imessage) para sa legacy na setup at addressing (`chat_id` ang mas inirerekomenda).

## Mga gabay sa adapter

- Ang Gateway ang may-ari ng proseso (ang start/stop ay naka-tali sa lifecycle ng provider).
- Panatilihing resilient ang mga RPC client: may mga timeout, mag-restart kapag nag-exit.
- Mas piliin ang mga stable ID (hal., `chat_id`) kaysa sa mga display string.
