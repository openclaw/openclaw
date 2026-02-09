---
summary: "„Loopback-WebChat-Static-Host und Gateway-WS-Nutzung für die Chat-UI“"
read_when:
  - Beim Debuggen oder Konfigurieren des WebChat-Zugriffs
title: "„WebChat“"
---

# WebChat (Gateway-WebSocket-UI)

Status: Die macOS/iOS-SwiftUI-Chat-UI spricht direkt mit dem Gateway-WebSocket.

## Was es ist

- Eine native Chat-UI für das Gateway (kein eingebetteter Browser und kein lokaler statischer Server).
- Verwendet dieselben Sitzungen und Routing-Regeln wie andere Kanäle.
- Deterministisches Routing: Antworten gehen immer an WebChat zurück.

## Schnellstart

1. Starten Sie das Gateway.
2. Öffnen Sie die WebChat-UI (macOS/iOS-App) oder den Chat-Tab der Control-UI.
3. Stellen Sie sicher, dass die Gateway-Authentifizierung konfiguriert ist (standardmäßig erforderlich, auch auf loopback).

## Funktionsweise (Verhalten)

- Die UI verbindet sich mit dem Gateway-WebSocket und verwendet `chat.history`, `chat.send` und `chat.inject`.
- `chat.inject` fügt dem Transkript direkt eine Assistenten-Notiz hinzu und überträgt sie an die UI (kein Agent-Lauf).
- Der Verlauf wird immer vom Gateway abgerufen (keine lokale Dateiüberwachung).
- Ist das Gateway nicht erreichbar, ist WebChat schreibgeschützt.

## Remote-Nutzung

- Der Remote-Modus tunnelt den Gateway-WebSocket über SSH/Tailscale.
- Sie müssen keinen separaten WebChat-Server betreiben.

## Konfigurationsreferenz (WebChat)

Vollständige Konfiguration: [Konfiguration](/gateway/configuration)

Kanaloptionen:

- Kein dedizierter `webchat.*`-Block. WebChat verwendet den Gateway-Endpunkt sowie die unten aufgeführten Authentifizierungseinstellungen.

Zugehörige globale Optionen:

- `gateway.port`, `gateway.bind`: WebSocket-Host/-Port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket-Authentifizierung.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: Ziel des Remote-Gateways.
- `session.*`: Sitzungsspeicher und Standardwerte für den Hauptschlüssel.
