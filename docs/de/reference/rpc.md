---
summary: "RPC-Adapter für externe CLIs (signal-cli, legacy imsg) und Gateway-Muster"
read_when:
  - Hinzufügen oder Ändern externer CLI-Integrationen
  - Debuggen von RPC-Adaptern (signal-cli, imsg)
title: "RPC-Adapter"
---

# RPC-Adapter

OpenClaw integriert externe CLIs über JSON-RPC. Derzeit werden zwei Muster verwendet.

## Muster A: HTTP-Daemon (signal-cli)

- `signal-cli` läuft als Daemon mit JSON-RPC über HTTP.
- Ereignisstrom ist SSE (`/api/v1/events`).
- Health-Probe: `/api/v1/check`.
- OpenClaw besitzt den Lebenszyklus, wenn `channels.signal.autoStart=true`.

Siehe [Signal](/channels/signal) für Einrichtung und Endpunkte.

## Muster B: stdio-Kindprozess (legacy: imsg)

> **Hinweis:** Für neue iMessage-Setups verwenden Sie stattdessen [BlueBubbles](/channels/bluebubbles).

- OpenClaw startet `imsg rpc` als Kindprozess (legacy iMessage-Integration).
- JSON-RPC ist zeilenbasiert über stdin/stdout (ein JSON-Objekt pro Zeile).
- Kein TCP-Port, kein Daemon erforderlich.

Verwendete Kernmethoden:

- `watch.subscribe` → Benachrichtigungen (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (Probe/Diagnose)

Siehe [iMessage](/channels/imessage) für das legacy Setup und die Adressierung (`chat_id` bevorzugt).

## Adapter-Richtlinien

- Der Gateway besitzt den Prozess (Start/Stopp an den Anbieter-Lebenszyklus gebunden).
- Halten Sie RPC-Clients robust: Timeouts, Neustart beim Beenden.
- Bevorzugen Sie stabile IDs (z. B. `chat_id`) gegenüber Anzeige-Strings.
