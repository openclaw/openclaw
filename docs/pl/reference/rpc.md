---
summary: "Adaptery RPC dla zewnętrznych CLI (signal-cli, legacy imsg) oraz wzorce bramy"
read_when:
  - Dodawanie lub zmiana integracji zewnętrznych CLI
  - Debugowanie adapterów RPC (signal-cli, imsg)
title: "Adaptery RPC"
---

# Adaptery RPC

OpenClaw integruje zewnętrzne CLI przez JSON-RPC. Obecnie stosowane są dwa wzorce.

## Wzorzec A: demon HTTP (signal-cli)

- `signal-cli` działa jako demon z JSON-RPC przez HTTP.
- Strumień zdarzeń to SSE (`/api/v1/events`).
- Sonda zdrowia: `/api/v1/check`.
- OpenClaw zarządza cyklem życia, gdy `channels.signal.autoStart=true`.

Zobacz [Signal](/channels/signal) — konfiguracja i punkty końcowe.

## Wzorzec B: proces potomny stdio (legacy: imsg)

> **Uwaga:** Dla nowych konfiguracji iMessage użyj [BlueBubbles](/channels/bluebubbles).

- OpenClaw uruchamia `imsg rpc` jako proces potomny (legacy integracja iMessage).
- JSON-RPC jest rozdzielany liniami przez stdin/stdout (jeden obiekt JSON na linię).
- Brak portu TCP, brak wymaganego demona.

Używane metody podstawowe:

- `watch.subscribe` → powiadomienia (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sonda/diagnostyka)

Zobacz [iMessage](/channels/imessage) — konfiguracja legacy i adresowanie (preferowane `chat_id`).

## Wytyczne dla adapterów

- Gateway jest właścicielem procesu (start/stop powiązane z cyklem życia dostawcy).
- Utrzymuj odporność klientów RPC: limity czasu, restart po zakończeniu procesu.
- Preferuj stabilne identyfikatory (np. `chat_id`) zamiast nazw wyświetlanych.
