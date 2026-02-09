---
summary: "„macOS-IPC-Architektur für die OpenClaw-App, den Gateway-Node-Transport und PeekabooBridge“"
read_when:
  - Bearbeiten von IPC-Verträgen oder der IPC der Menüleisten-App
title: "„macOS-IPC“"
---

# OpenClaw macOS-IPC-Architektur

**Aktuelles Modell:** Ein lokaler Unix-Socket verbindet den **Node-Host-Service** mit der **macOS-App** für Exec-Freigaben + `system.run`. Eine `openclaw-mac` Debug-CLI existiert für Discovery-/Verbindungsprüfungen; Agent-Aktionen fließen weiterhin über den Gateway-WebSocket und `node.invoke`. UI-Automatisierung nutzt PeekabooBridge.

## Ziele

- Eine einzelne GUI-App-Instanz, die alle TCC-relevanten Aufgaben übernimmt (Benachrichtigungen, Bildschirmaufzeichnung, Mikrofon, Sprache, AppleScript).
- Eine kleine Angriffsfläche für Automatisierung: Gateway + Node-Befehle sowie PeekabooBridge für UI-Automatisierung.
- Vorhersehbare Berechtigungen: immer dieselbe signierte Bundle-ID, gestartet durch launchd, sodass TCC-Freigaben bestehen bleiben.

## Wie es funktioniert

### Gateway + Node-Transport

- Die App betreibt das Gateway (lokaler Modus) und verbindet sich als Node damit.
- Agent-Aktionen werden über `node.invoke` ausgeführt (z. B. `system.run`, `system.notify`, `canvas.*`).

### Node-Service + App-IPC

- Ein headless Node-Host-Service verbindet sich mit dem Gateway-WebSocket.
- `system.run`-Anfragen werden über einen lokalen Unix-Socket an die macOS-App weitergeleitet.
- Die App führt den Exec im UI-Kontext aus, fordert bei Bedarf eine Bestätigung an und gibt die Ausgabe zurück.

Diagramm (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI-Automatisierung)

- UI-Automatisierung verwendet einen separaten UNIX-Socket mit dem Namen `bridge.sock` und das PeekabooBridge-JSON-Protokoll.
- Host-Präferenzreihenfolge (clientseitig): Peekaboo.app → Claude.app → OpenClaw.app → lokale Ausführung.
- Sicherheit: Bridge-Hosts erfordern eine erlaubte TeamID; ein nur für DEBUG verfügbarer Same-UID-Notausgang ist durch `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` geschützt (Peekaboo-Konvention).
- Siehe: [PeekabooBridge usage](/platforms/mac/peekaboo) für Details.

## Betriebsabläufe

- Neustart/Neuaufbau: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Beendet bestehende Instanzen
  - Swift-Build + Paketierung
  - Schreibt/bootstrapped/kickstartet den LaunchAgent
- Einzelinstanz: Die App beendet sich frühzeitig, wenn eine andere Instanz mit derselben Bundle-ID läuft.

## Hinweise zur Härtung

- Bevorzugen Sie die Anforderung einer TeamID-Übereinstimmung für alle privilegierten Oberflächen.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (nur DEBUG) kann Same-UID-Aufrufer für lokale Entwicklung zulassen.
- Sämtliche Kommunikation bleibt ausschließlich lokal; es werden keine Netzwerk-Sockets exponiert.
- TCC-Abfragen stammen ausschließlich aus dem GUI-App-Bundle; halten Sie die signierte Bundle-ID über Neubuilds hinweg stabil.
- IPC-Härtung: Socket-Modus `0600`, Token, Peer-UID-Prüfungen, HMAC-Challenge/Response, kurze TTL.
