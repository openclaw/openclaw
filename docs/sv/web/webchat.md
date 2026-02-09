---
summary: "Loopback WebChat statisk värd och Gateway WS-användning för chatt-UI"
read_when:
  - Felsökning eller konfigurering av WebChat-åtkomst
title: "WebChat"
---

# WebChat (Gateway WebSocket-UI)

Status: macOS/iOS SwiftUI-chatt-UI:t pratar direkt med Gateway WebSocket.

## Vad det är

- Ett inbyggt chatt-UI för gatewayn (ingen inbäddad webbläsare och ingen lokal statisk server).
- Använder samma sessioner och routningsregler som andra kanaler.
- Deterministisk routning: svar går alltid tillbaka till WebChat.

## Snabbstart

1. Starta gatewayn.
2. Öppna WebChat-UI:t (macOS/iOS-appen) eller chattfliken i Control UI.
3. Säkerställ att gateway-autentisering är konfigurerad (krävs som standard, även på loopback).

## Hur det fungerar (beteende)

- UI:t ansluter till Gateway WebSocket och använder `chat.history`, `chat.send` och `chat.inject`.
- `chat.inject` lägger till en assistentnotering direkt i transkriptet och sänder den till UI:t (ingen agentkörning).
- Historik hämtas alltid från gatewayn (ingen lokal filbevakning).
- Om gatewayn inte kan nås är WebChat skrivskyddat.

## Fjärranvändning

- Fjärrläge tunnlar Gateway WebSocket över SSH/Tailscale.
- Du behöver inte köra en separat WebChat-server.

## Konfigurationsreferens (WebChat)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Kanalalternativ:

- Inga dedikerade `webchat.*` block. WebChat använder gateway slutpunkt + auth inställningar nedan.

Relaterade globala alternativ:

- `gateway.port`, `gateway.bind`: WebSocket-värd/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket-autentisering.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: fjärr gateway-mål.
- `session.*`: sessionslagring och standardvärden för huvudnyckel.
