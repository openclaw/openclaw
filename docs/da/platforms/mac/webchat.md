---
summary: "Sådan indlejrer mac-appen gatewayens WebChat, og hvordan du debugger den"
read_when:
  - Fejlfinding af mac WebChat-visning eller loopback-port
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:28Z
---

# WebChat (macOS-app)

macOS-menulinjeappen indlejrer WebChat-UI’et som en indbygget SwiftUI-visning. Den
forbinder til Gateway og bruger som standard **hovedsessionen** for den valgte
agent (med en sessionsskifter til andre sessioner).

- **Lokal tilstand**: forbinder direkte til den lokale Gateway WebSocket.
- **Fjern-tilstand**: videresender Gateway-kontrolporten over SSH og bruger den
  tunnel som dataplan.

## Start & fejlfinding

- Manuelt: Lobster-menu → “Open Chat”.
- Automatisk åbning til test:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logfiler: `./scripts/clawlog.sh` (undersystem `bot.molt`, kategori `WebChatSwiftUI`).

## Sådan er det koblet sammen

- Dataplan: Gateway WS-metoder `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` samt events `chat`, `agent`, `presence`, `tick`, `health`.
- Session: bruger som standard den primære session (`main`, eller `global` når scope er
  globalt). UI’et kan skifte mellem sessioner.
- Introduktion bruger en dedikeret session for at holde førstegangsopsætning adskilt.

## Sikkerhedsflade

- Fjern-tilstand videresender kun Gateway WebSocket-kontrolporten over SSH.

## Kendte begrænsninger

- UI’et er optimeret til chatsessioner (ikke en fuld browser-sandbox).
