---
summary: "Hur macOS-appen bäddar in Gateway WebChat och hur du felsöker den"
read_when:
  - Felsökning av macOS WebChat-vy eller loopback-port
title: "WebChat"
---

# WebChat (macOS-app)

Appen för macOS-menyfältet bäddar in WebChat UI som en infödd SwiftUI-vy. It
ansluter till Gateway och är standard för **huvudsessionen** för den valda
-agenten (med en sessionsväxlare för andra sessioner).

- **Lokalt läge**: ansluter direkt till den lokala Gateway WebSocket.
- **Fjärrläge**: vidarebefordrar Gateways kontrollport över SSH och använder den
  tunneln som dataplan.

## Start & felsökning

- Manuell: Lobster-menyn → ”Öppna chatt”.

- Öppna automatiskt för testning:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Loggar: `./scripts/clawlog.sh` (undersystem `bot.molt`, kategori `WebChatSwiftUI`).

## Hur det är kopplat

- Dataplan: Gateway WS‑metoder `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` och händelser `chat`, `agent`, `presence`, `tick`, `health`.
- Session: standard är den primära sessionen (`main`, eller `global` när omfattningen är
  global). UI kan växla mellan sessioner.
- Introduktionen använder en dedikerad session för att hålla första‑gången‑konfigureringen separat.

## Säkerhetsyta

- Fjärrläget vidarebefordrar endast Gateways WebSocket‑kontrollport över SSH.

## Kända begränsningar

- UI:t är optimerat för chattsessioner (inte en fullständig webbläsar‑sandbox).
