---
summary: "Hur macOS-appen bäddar in Gateway WebChat och hur du felsöker den"
read_when:
  - Felsökning av macOS WebChat-vy eller loopback-port
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:05Z
---

# WebChat (macOS-app)

macOS-menyradsappen bäddar in WebChat‑gränssnittet som en inbyggd SwiftUI‑vy. Den
ansluter till Gateway (nätverksgateway) och använder som standard **huvudsessionen** för den valda
agenten (med en sessionsväxlare för andra sessioner).

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
- Session: använder som standard den primära sessionen (`main`, eller `global` när omfånget är
  globalt). UI:t kan växla mellan sessioner.
- Introduktionen använder en dedikerad session för att hålla första‑gången‑konfigureringen separat.

## Säkerhetsyta

- Fjärrläget vidarebefordrar endast Gateways WebSocket‑kontrollport över SSH.

## Kända begränsningar

- UI:t är optimerat för chattsessioner (inte en fullständig webbläsar‑sandbox).
