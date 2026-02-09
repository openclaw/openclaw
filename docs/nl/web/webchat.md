---
summary: "Loopback WebChat statische host en Gateway WS-gebruik voor chat-UI"
read_when:
  - Debuggen of configureren van WebChat-toegang
title: "WebChat"
---

# WebChat (Gateway WebSocket-UI)

Status: de macOS/iOS SwiftUI-chat-UI communiceert rechtstreeks met de Gateway WebSocket.

## Wat het is

- Een native chat-UI voor de Gateway (geen ingebedde browser en geen lokale statische server).
- Gebruikt dezelfde sessies en routeringsregels als andere kanalen.
- Deterministische routering: antwoorden gaan altijd terug naar WebChat.

## Snelle start

1. Start de Gateway.
2. Open de WebChat-UI (macOS/iOS-app) of het chat-tabblad van de Control UI.
3. Zorg ervoor dat Gateway-authenticatie is geconfigureerd (standaard vereist, zelfs op local loopback).

## Hoe het werkt (gedrag)

- De UI maakt verbinding met de Gateway WebSocket en gebruikt `chat.history`, `chat.send` en `chat.inject`.
- `chat.inject` voegt een assistent-notitie rechtstreeks toe aan het transcript en zendt deze uit naar de UI (geen agent-run).
- Geschiedenis wordt altijd opgehaald vanaf de Gateway (geen lokale bestandsmonitoring).
- Als de Gateway niet bereikbaar is, is WebChat alleen-lezen.

## Gebruik op afstand

- De modus voor gebruik op afstand tunnelt de Gateway WebSocket via SSH/Tailscale.
- Je hoeft geen aparte WebChat-server te draaien.

## Configuratiereferentie (WebChat)

Volledige configuratie: [Configuratie](/gateway/configuration)

Kanaalopties:

- Geen speciaal `webchat.*`-blok. WebChat gebruikt het Gateway-eindpunt + de onderstaande authenticatie-instellingen.

Gerelateerde globale opties:

- `gateway.port`, `gateway.bind`: WebSocket-host/poort.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket-authenticatie.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: doel van de Gateway op afstand.
- `session.*`: sessieopslag en standaardwaarden voor de hoofdsleutel.
