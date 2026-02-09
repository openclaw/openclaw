---
summary: "„Clawnet-Refactor: Vereinheitlichung von Netzwerkprotokoll, Rollen, Authentifizierung, Genehmigungen und Identität“"
read_when:
  - Planung eines einheitlichen Netzwerkprotokolls für Nodes und Operator-Clients
  - Überarbeitung von Genehmigungen, Pairing, TLS und Presence über Geräte hinweg
title: "„Clawnet-Refactor“"
---

# Clawnet-Refactor (Vereinheitlichung von Protokoll + Authentifizierung)

## Hi

Hi Peter — großartige Richtung; das ermöglicht eine einfachere UX und stärkere Sicherheit.

## Zweck

Ein einzelnes, stringentes Dokument für:

- Ist-Zustand: Protokolle, Abläufe, Vertrauensgrenzen.
- Schmerzpunkte: Genehmigungen, Multi-Hop-Routing, UI-Duplizierung.
- Vorgeschlagener Zielzustand: ein Protokoll, klar abgegrenzte Rollen, vereinheitlichte Authentifizierung/Pairing, TLS-Pinning.
- Identitätsmodell: stabile IDs + hübsche Slugs.
- Migrationsplan, Risiken, offene Fragen.

## Ziele (aus der Diskussion)

- Ein Protokoll für alle Clients (Mac-App, CLI, iOS, Android, Headless-Node).
- Jeder Netzwerkteilnehmer ist authentifiziert + gepairt.
- Klare Rollen: Nodes vs. Operatoren.
- Zentrale Genehmigungen, dorthin geroutet, wo sich der Nutzer befindet.
- TLS-Verschlüsselung + optionales Pinning für allen Remote-Traffic.
- Minimale Code-Duplizierung.
- Eine einzelne Maschine soll nur einmal erscheinen (keine UI/Node-Doppeleinträge).

## Keine Ziele (explizit)

- Trennung von Fähigkeiten entfernen (Least-Privilege bleibt erforderlich).
- Die vollständige Gateway-Control-Plane ohne Scope-Prüfungen exponieren.
- Authentifizierung von menschlichen Labels abhängig machen (Slugs bleiben nicht sicherheitsrelevant).

---

# Aktueller Zustand (Ist)

## Zwei Protokolle

### 1. Gateway WebSocket (Control Plane)

- Vollständige API-Oberfläche: Konfiguration, Kanäle, Modelle, Sitzungen, Agent-Runs, Logs, Nodes usw.
- Standard-Bind: Loopback. Remote-Zugriff via SSH/Tailscale.
- Authentifizierung: Token/Passwort über `connect`.
- Kein TLS-Pinning (verlässt sich auf Loopback/Tunnel).
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (Node-Transport)

- Enge Allowlist-Oberfläche, Node-Identität + Pairing.
- JSONL über TCP; optional TLS + Zertifikats-Fingerprint-Pinning.
- TLS bewirbt den Fingerprint in Discovery-TXT.
- Code:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Control-Plane-Clients heute

- CLI → Gateway-WS via `callGateway` (`src/gateway/call.ts`).
- macOS-App-UI → Gateway-WS (`GatewayConnection`).
- Web-Control-UI → Gateway-WS.
- ACP → Gateway-WS.
- Browser-Control nutzt seinen eigenen HTTP-Control-Server.

## Nodes heute

- macOS-App im Node-Modus verbindet sich mit der Gateway-Bridge (`MacNodeBridgeSession`).
- iOS/Android-Apps verbinden sich mit der Gateway-Bridge.
- Pairing + Node-spezifischer Token werden auf dem Gateway gespeichert.

## Aktueller Genehmigungsfluss (Exec)

- Agent nutzt `system.run` über das Gateway.
- Gateway ruft den Node über die Bridge auf.
- Die Node-Runtime entscheidet über die Genehmigung.
- UI-Prompt wird von der Mac-App angezeigt (wenn Node == Mac-App).
- Node gibt `invoke-res` an das Gateway zurück.
- Multi-Hop, UI an den Node-Host gebunden.

## Presence + Identität heute

- Gateway-Presence-Einträge aus WS-Clients.
- Node-Presence-Einträge aus der Bridge.
- Die Mac-App kann zwei Einträge für dieselbe Maschine anzeigen (UI + Node).
- Node-Identität im Pairing-Store gespeichert; UI-Identität separat.

---

# Probleme / Schmerzpunkte

- Zwei Protokoll-Stacks zu warten (WS + Bridge).
- Genehmigungen auf Remote-Nodes: Prompt erscheint auf dem Node-Host, nicht dort, wo der Nutzer ist.
- TLS-Pinning existiert nur für die Bridge; WS hängt von SSH/Tailscale ab.
- Identitätsduplikation: dieselbe Maschine erscheint als mehrere Instanzen.
- Unklare Rollen: UI-, Node- und CLI-Fähigkeiten nicht sauber getrennt.

---

# Neuer Zustand (Clawnet)

## Ein Protokoll, zwei Rollen

Ein einzelnes WS-Protokoll mit Rolle + Scope.

- **Rolle: Node** (Fähigkeits-Host)
- **Rolle: Operator** (Control Plane)
- Optionaler **Scope** für Operator:
  - `operator.read` (Status + Ansicht)
  - `operator.write` (Agent-Run, Sends)
  - `operator.admin` (Konfiguration, Kanäle, Modelle)

### Rollenverhalten

**Node**

- Kann Fähigkeiten registrieren (`caps`, `commands`, Berechtigungen).
- Kann `invoke`-Befehle empfangen (`system.run`, `camera.*`, `canvas.*`, `screen.record` usw.).
- Kann Events senden: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Kann keine Control-Plane-APIs für Konfiguration/Modelle/Kanäle/Sitzungen/Agenten aufrufen.

**Operator**

- Vollständige Control-Plane-API, durch Scopes begrenzt.
- Empfängt alle Genehmigungen.
- Führt keine OS-Aktionen direkt aus; routet zu Nodes.

### Zentrale Regel

Die Rolle ist pro Verbindung, nicht pro Gerät. Ein Gerät kann beide Rollen separat öffnen.

---

# Vereinheitlichte Authentifizierung + Pairing

## Client-Identität

Jeder Client liefert:

- `deviceId` (stabil, aus dem Geräteschlüssel abgeleitet).
- `displayName` (Name für Menschen).
- `role` + `scope` + `caps` + `commands`.

## Pairing-Ablauf (vereinheitlicht)

- Client verbindet sich unauthentifiziert.
- Gateway erstellt eine **Pairing-Anfrage** für diese `deviceId`.
- Operator erhält eine Aufforderung; genehmigt oder lehnt ab.
- Gateway stellt Credentials aus, gebunden an:
  - öffentlichen Geräteschlüssel
  - Rolle(n)
  - Scope(s)
  - Fähigkeiten/Befehle
- Client persistiert den Token und verbindet sich authentifiziert erneut.

## Gerätegebundene Authentifizierung (Replay von Bearer-Tokens vermeiden)

Bevorzugt: Geräteschlüsselpaare.

- Gerät erzeugt einmalig ein Schlüsselpaar.
- `deviceId = fingerprint(publicKey)`.
- Gateway sendet Nonce; Gerät signiert; Gateway verifiziert.
- Tokens werden an einen öffentlichen Schlüssel (Proof-of-Possession) gebunden, nicht an einen String.

Alternativen:

- mTLS (Client-Zertifikate): am stärksten, höhere operative Komplexität.
- Kurzlebige Bearer-Tokens nur als Übergangsphase (früh rotieren + widerrufen).

## Stille Genehmigung (SSH-Heuristik)

Präzise definieren, um eine Schwachstelle zu vermeiden. Bevorzugen Sie eine Option:

- **Nur lokal**: Auto-Pairing, wenn der Client über Loopback/Unix-Socket verbindet.
- **Challenge via SSH**: Gateway stellt Nonce aus; Client weist SSH nach, indem er sie abruft.
- **Zeitfenster physischer Präsenz**: Nach einer lokalen Genehmigung auf der Gateway-Host-UI ist Auto-Pairing für ein kurzes Zeitfenster erlaubt (z. B. 10 Minuten).

Immer protokollieren + Auto-Genehmigungen erfassen.

---

# TLS überall (Dev + Prod)

## Bestehendes Bridge-TLS wiederverwenden

Aktuelle TLS-Runtime + Fingerprint-Pinning nutzen:

- `src/infra/bridge/server/tls.ts`
- Fingerprint-Verifikationslogik in `src/node-host/bridge-client.ts`

## Auf WS anwenden

- WS-Server unterstützt TLS mit demselben Zertifikat/Schlüssel + Fingerprint.
- WS-Clients können den Fingerprint pinnen (optional).
- Discovery bewirbt TLS + Fingerprint für alle Endpunkte.
  - Discovery ist nur Locator-Hinweise; niemals ein Trust Anchor.

## Warum

- Abhängigkeit von SSH/Tailscale für Vertraulichkeit reduzieren.
- Remote-Mobilverbindungen standardmäßig sicher machen.

---

# Neugestaltung der Genehmigungen (zentralisiert)

## Aktuell

Genehmigung erfolgt auf dem Node-Host (Mac-App-Node-Runtime). Der Prompt erscheint dort, wo der Node läuft.

## Geplant

Genehmigung ist **Gateway-gehostet**, UI wird an Operator-Clients ausgeliefert.

### Neuer Ablauf

1. Gateway erhält `system.run`-Intent (Agent).
2. Gateway erstellt einen Genehmigungsdatensatz: `approval.requested`.
3. Operator-UI(s) zeigen den Prompt.
4. Genehmigungsentscheidung wird an das Gateway gesendet: `approval.resolve`.
5. Gateway ruft bei Genehmigung den Node-Befehl auf.
6. Node führt aus und gibt `invoke-res` zurück.

### Genehmigungssemantik (Härtung)

- Broadcast an alle Operatoren; nur die aktive UI zeigt ein Modal (andere erhalten einen Toast).
- Die erste Entscheidung gewinnt; das Gateway lehnt weitere Auflösungen als bereits erledigt ab.
- Standard-Timeout: Ablehnen nach N Sekunden (z. B. 60 s), Grund protokollieren.
- Auflösung erfordert `operator.approvals`-Scope.

## Vorteile

- Prompt erscheint dort, wo der Nutzer ist (Mac/Telefon).
- Konsistente Genehmigungen für Remote-Nodes.
- Node-Runtime bleibt headless; keine UI-Abhängigkeit.

---

# Beispiele für Rollenklarheit

## iPhone-App

- **Node-Rolle** für: Mikrofon, Kamera, Voice-Chat, Standort, Push-to-Talk.
- Optional **operator.read** für Status und Chat-Ansicht.
- Optional **operator.write/admin** nur bei expliziter Aktivierung.

## macOS-App

- Standardmäßig Operator-Rolle (Control-UI).
- Node-Rolle, wenn „Mac-Node“ aktiviert ist (system.run, Screen, Kamera).
- Gleiche deviceId für beide Verbindungen → zusammengeführter UI-Eintrag.

## CLI

- Immer Operator-Rolle.
- Scope abgeleitet vom Subcommand:
  - `status`, `logs` → Read
  - `agent`, `message` → Write
  - `config`, `channels` → Admin
  - Genehmigungen + Pairing → `operator.approvals` / `operator.pairing`

---

# Identität + Slugs

## Stabile ID

Für Authentifizierung erforderlich; ändert sich nie.
Bevorzugt:

- Keypair-Fingerprint (Public-Key-Hash).

## Hübscher Slug (Hummer-Thema)

Nur menschliches Label.

- Beispiel: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Im Gateway-Register gespeichert, editierbar.
- Kollisionsbehandlung: `-2`, `-3`.

## UI-Gruppierung

Gleiche `deviceId` über Rollen hinweg → eine einzelne „Instanz“-Zeile:

- Badge: `operator`, `node`.
- Zeigt Fähigkeiten + „zuletzt gesehen“.

---

# Migrationsstrategie

## Phase 0: Dokumentieren + abstimmen

- Dieses Dokument veröffentlichen.
- Alle Protokollaufrufe + Genehmigungsflüsse inventarisieren.

## Phase 1: Rollen/Scopes zu WS hinzufügen

- `connect`-Parameter um `role`, `scope`, `deviceId` erweitern.
- Allowlist-Gating für die Node-Rolle hinzufügen.

## Phase 2: Bridge-Kompatibilität

- Bridge weiter betreiben.
- WS-Node-Support parallel hinzufügen.
- Features hinter Konfigurations-Flag schalten.

## Phase 3: Zentrale Genehmigungen

- Genehmigungsanfrage- + Auflösungs-Events in WS hinzufügen.
- macOS-App-UI aktualisieren, um Prompts anzuzeigen + zu antworten.
- Node-Runtime zeigt keine UI-Prompts mehr.

## Phase 4: TLS-Vereinheitlichung

- TLS-Konfiguration für WS mit der Bridge-TLS-Runtime hinzufügen.
- Pinning zu Clients hinzufügen.

## Phase 5: Bridge ausphasen

- iOS/Android/macOS-Node auf WS migrieren.
- Bridge als Fallback behalten; nach Stabilisierung entfernen.

## Phase 6: Gerätegebundene Authentifizierung

- Schlüsselbasierte Identität für alle nicht-lokalen Verbindungen erzwingen.
- Widerrufs- + Rotations-UI hinzufügen.

---

# Sicherheitshinweise

- Rollen/Allowlist werden an der Gateway-Grenze durchgesetzt.
- Kein Client erhält die „vollständige“ API ohne Operator-Scope.
- Pairing ist für _alle_ Verbindungen erforderlich.
- TLS + Pinning reduziert MITM-Risiken für Mobilgeräte.
- Stille Genehmigung via SSH ist Komfort; weiterhin protokolliert + widerrufbar.
- Discovery ist niemals ein Trust Anchor.
- Leistungsansprüche werden mit Serverzulisten nach Plattform/Typ verifiziert.

# Streaming + große Payloads (Node-Medien)

Die WS-Control-Plane ist für kleine Nachrichten geeignet, aber Nodes machen auch:

- Kameraclips
- Bildschirmaufzeichnungen
- Audio-Streams

Optionen:

1. WS-Binary-Frames + Chunking + Backpressure-Regeln.
2. Separater Streaming-Endpunkt (weiterhin TLS + Auth).
3. Bridge für medienlastige Befehle länger beibehalten, zuletzt migrieren.

Vor der Implementierung eine Option wählen, um Drift zu vermeiden.

# Fähigkeits- + Befehlsrichtlinie

- Knoten - gemeldete Caps/Commands werden als **claims** behandelt.
- Gateway erzwingt die erlaubten Listen auf Plattformen.
- Jeder neue Befehl erfordert Operator-Genehmigung oder eine explizite Allowlist-Änderung.
- Änderungen mit Zeitstempeln auditieren.

# Audit + Rate Limiting

- Protokollieren: Pairing-Anfragen, Genehmigungen/Ablehnungen, Token-Ausgabe/-Rotation/-Widerruf.
- Pairing-Spam und Genehmigungs-Prompts rate-limitieren.

# Protokollhygiene

- Explizite Protokollversion + Fehlercodes.
- Reconnect-Regeln + Heartbeat-Policy.
- Presence-TTL und „Last-Seen“-Semantik.

---

# Offene Fragen

1. Einzelnes Gerät mit beiden Rollen: Token-Modell
   - Empfehlung: getrennte Tokens pro Rolle (Node vs. Operator).
   - Gleiche deviceId; unterschiedliche Scopes; klarere Widerrufe.

2. Granularität der Operator-Scopes
   - Read/Write/Admin + Genehmigungen + Pairing (Minimalumfang).
   - Später per-Feature-Scopes erwägen.

3. UX für Token-Rotation + Widerruf
   - Automatische Rotation bei Rollenänderung.
   - UI zum Widerruf nach deviceId + Rolle.

4. Discovery
   - Aktuelles Bonjour-TXT um WS-TLS-Fingerprint + Rollenhinweise erweitern.
   - Nur als Locator-Hinweise behandeln.

5. Netzwerkübergreifende Genehmigung
   - Broadcast an alle Operator-Clients; aktive UI zeigt Modal.
   - Erste Antwort gewinnt; Gateway erzwingt Atomarität.

---

# Zusammenfassung (TL;DR)

- Heute: WS-Control-Plane + Bridge-Node-Transport.
- Schmerzpunkte: Genehmigungen + Duplikation + zwei Stacks.
- Vorschlag: ein WS-Protokoll mit expliziten Rollen + Scopes, vereinheitlichtes Pairing + TLS-Pinning, Gateway-gehostete Genehmigungen, stabile Geräte-IDs + hübsche Slugs.
- Ergebnis: einfachere UX, stärkere Sicherheit, weniger Duplikation, besseres Mobile-Routing.
