---
summary: "„Wie OpenClaw-Presence-Einträge erzeugt, zusammengeführt und angezeigt werden“"
read_when:
  - Debugging der Registerkarte „Instances“
  - Untersuchung doppelter oder veralteter Instanzzeilen
  - Änderung der Gateway-WS-Verbindung oder von System-Event-Beacons
title: "Presence"
---

# Presence

OpenClaw-„Presence“ ist eine leichtgewichtige, Best‑Effort-Ansicht von:

- dem **Gateway** selbst und
- **Clients, die mit dem Gateway verbunden sind** (macOS-App, WebChat, CLI usw.)

Presence wird primär verwendet, um die Registerkarte **Instances** der macOS-App
darzustellen und eine schnelle Sichtbarkeit für Operatoren zu bieten.

## Presence-Felder (was angezeigt wird)

Presence-Einträge sind strukturierte Objekte mit Feldern wie:

- `instanceId` (optional, aber dringend empfohlen): stabile Client-Identität (meist `connect.client.instanceId`)
- `host`: benutzerfreundlicher Hostname
- `ip`: Best‑Effort-IP-Adresse
- `version`: Client-Versionsstring
- `deviceFamily` / `modelIdentifier`: Hardware-Hinweise
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: „Sekunden seit letzter Benutzereingabe“ (falls bekannt)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: Zeitstempel der letzten Aktualisierung (ms seit Epoche)

## Erzeuger (woher Presence stammt)

Presence-Einträge werden von mehreren Quellen erzeugt und **zusammengeführt**.

### 1. Gateway-Selbsteintrag

Das Gateway legt beim Start immer einen „Self“-Eintrag an, sodass UIs den
Gateway-Host anzeigen, noch bevor sich Clients verbinden.

### 2. WebSocket-Verbindung

Jeder WS-Client beginnt mit einer `connect`-Anfrage. Nach erfolgreichem
Handshake führt das Gateway ein Upsert eines Presence-Eintrags für diese
Verbindung aus.

#### Warum einmalige CLI-Befehle nicht erscheinen

Die CLI verbindet sich häufig nur kurz für einmalige Befehle. Um ein
Überfluten der Instances-Liste zu vermeiden, wird `client.mode === "cli"` **nicht**
in einen Presence-Eintrag umgewandelt.

### 3. `system-event`-Beacons

Clients können reichhaltigere periodische Beacons über die Methode
`system-event` senden. Die macOS-App nutzt dies, um Hostname, IP und
`lastInputSeconds` zu melden.

### 4. Node-Verbindungen (Rolle: node)

Wenn sich ein Node über den Gateway-WebSocket mit `role: node` verbindet,
führt das Gateway ein Upsert eines Presence-Eintrags für diesen Node aus
(gleicher Ablauf wie bei anderen WS-Clients).

## Merge- und Deduplizierungsregeln (warum `instanceId` wichtig ist)

Presence-Einträge werden in einer einzigen In-Memory-Map gespeichert:

- Einträge werden durch einen **Presence-Schlüssel** identifiziert.
- Der beste Schlüssel ist eine stabile `instanceId` (aus `connect.client.instanceId`),
  die Neustarts überdauert.
- Schlüssel sind nicht groß-/kleinschreibungssensitiv.

Wenn sich ein Client ohne eine stabile `instanceId` erneut verbindet, kann
er als **doppelte** Zeile erscheinen.

## TTL und begrenzte Größe

Presence ist absichtlich ephemer:

- **TTL:** Einträge, die älter als 5 Minuten sind, werden entfernt
- **Max. Einträge:** 200 (älteste werden zuerst verworfen)

Dies hält die Liste aktuell und verhindert unbegrenztes Speicherwachstum.

## Remote-/Tunnel-Hinweis (Loopback-IP-Adressen)

Wenn sich ein Client über einen SSH-Tunnel / lokale Portweiterleitung verbindet,
kann das Gateway die entfernte Adresse als `127.0.0.1` sehen. Um eine gute,
vom Client gemeldete IP nicht zu überschreiben, werden Loopback-Remote-Adressen
ignoriert.

## Konsumenten

### Registerkarte „Instances“ in macOS

Die macOS-App rendert die Ausgabe von `system-presence` und wendet einen kleinen
Statusindikator (Aktiv/Idle/Veraltet) basierend auf dem Alter der letzten
Aktualisierung an.

## Debugging-Tipps

- Um die Rohdatenliste zu sehen, rufen Sie `system-presence` gegen das Gateway auf.
- Wenn Sie Duplikate sehen:
  - bestätigen Sie, dass Clients beim Handshake eine stabile `client.instanceId` senden
  - bestätigen Sie, dass periodische Beacons dieselbe `instanceId` verwenden
  - prüfen Sie, ob dem verbindungsbasierten Eintrag `instanceId` fehlt
    (Duplikate sind dann zu erwarten)
