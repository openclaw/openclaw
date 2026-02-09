---
summary: "Loopback WebChat statisk host og Gateway WS-brug til chat-UI"
read_when:
  - Fejlfinding eller konfiguration af WebChat-adgang
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

Status: macOS/iOS SwiftUI-chat-UI’en taler direkte med Gateway WebSocket.

## Hvad det er

- En native chat-UI til gatewayen (ingen indlejret browser og ingen lokal statisk server).
- Bruger de samme sessioner og routingregler som andre kanaler.
- Deterministisk routing: svar sendes altid tilbage til WebChat.

## Hurtig start

1. Start gatewayen.
2. Åbn WebChat-UI’en (macOS/iOS-app) eller chatfanen i Kontrol-UI.
3. Sørg for, at gateway-autentificering er konfigureret (påkrævet som standard, selv på loopback).

## Sådan virker det (adfærd)

- UI’en forbinder til Gateway WebSocket og bruger `chat.history`, `chat.send` og `chat.inject`.
- `chat.inject` tilføjer en assistentnote direkte til transskriptionen og udsender den til UI’en (ingen agentkørsel).
- Historik hentes altid fra gatewayen (ingen lokal filovervågning).
- Hvis gatewayen er utilgængelig, er WebChat skrivebeskyttet.

## Fjernbrug

- Fjern-tilstand tunneler gatewayens WebSocket over SSH/Tailscale.
- Du behøver ikke at køre en separat WebChat-server.

## Konfigurationsreference (WebChat)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Kanalindstillinger:

- Ingen dedikeret `webchat.*` blok. WebChat bruger gateway endpoint + auth indstillinger nedenfor.

Relaterede globale indstillinger:

- `gateway.port`, `gateway.bind`: WebSocket-vært/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket-autentificering.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: fjern gateway-mål.
- `session.*`: sessionslager og standarder for hovednøgle.
