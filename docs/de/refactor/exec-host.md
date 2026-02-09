---
summary: "Refactor-Plan: Exec-Host-Routing, Node-Genehmigungen und Headless Runner"
read_when:
  - Entwurf des Exec-Host-Routings oder der Exec-Genehmigungen
  - Implementierung von Node-Runner + UI-IPC
  - Hinzufügen von Exec-Host-Sicherheitsmodi und Slash-Befehlen
title: "Exec-Host-Refactor"
---

# Exec-Host-Refactor-Plan

## Ziele

- Hinzufügen von `exec.host` + `exec.security`, um die Ausführung über **sandbox**, **gateway** und **node** zu routen.
- Sichere **Standardwerte** beibehalten: keine hostübergreifende Ausführung, sofern nicht ausdrücklich aktiviert.
- Aufteilung der Ausführung in einen **Headless-Runner-Dienst** mit optionaler UI (macOS-App) über lokales IPC.
- Bereitstellung von **Agent-spezifischer** Richtlinie, Allowlist, Ask-Modus und Node-Bindung.
- Unterstützung von **Ask-Modi**, die _mit_ oder _ohne_ Allowlists funktionieren.
- Plattformübergreifend: Unix-Socket + Token-Authentifizierung (macOS/Linux/Windows-Parität).

## Nicht-Ziele

- Keine Migration von Legacy-Allowlists oder Unterstützung von Legacy-Schemata.
- Kein PTY/Streaming für Node-Exec (nur aggregierte Ausgabe).
- Keine neue Netzwerkschicht über Bridge + Gateway hinaus.

## Entscheidungen (festgelegt)

- **Konfigurationsschlüssel:** `exec.host` + `exec.security` (Agent-spezifische Überschreibung erlaubt).
- **Erhöhung:** `/elevated` als Alias für vollständigen Gateway-Zugriff beibehalten.
- **Ask-Standard:** `on-miss`.
- **Genehmigungsspeicher:** `~/.openclaw/exec-approvals.json` (JSON, keine Legacy-Migration).
- **Runner:** Headless-Systemdienst; die UI-App hostet einen Unix-Socket für Genehmigungen.
- **Node-Identität:** bestehendes `nodeId` verwenden.
- **Socket-Auth:** Unix-Socket + Token (plattformübergreifend); spätere Aufteilung bei Bedarf.
- **Node-Host-Zustand:** `~/.openclaw/node.json` (Node-ID + Pairing-Token).
- **macOS-Exec-Host:** `system.run` innerhalb der macOS-App ausführen; der Node-Host-Dienst leitet Anfragen über lokales IPC weiter.
- **Kein XPC-Helper:** bei Unix-Socket + Token + Peer-Checks bleiben.

## Schlüsselkonzepte

### Host

- `sandbox`: Docker-Exec (aktuelles Verhalten).
- `gateway`: Exec auf dem Gateway-Host.
- `node`: Exec auf dem Node-Runner über Bridge (`system.run`).

### Sicherheitsmodus

- `deny`: immer blockieren.
- `allowlist`: nur Übereinstimmungen zulassen.
- `full`: alles zulassen (äquivalent zu erhöht).

### Ask-Modus

- `off`: nie fragen.
- `on-miss`: nur fragen, wenn die Allowlist nicht passt.
- `always`: jedes Mal fragen.

Ask ist **unabhängig** von der Allowlist; die Allowlist kann mit `always` oder `on-miss` verwendet werden.

### Richtlinienauflösung (pro Exec)

1. `exec.host` auflösen (Tool-Parameter → Agent-Override → globaler Standard).
2. `exec.security` und `exec.ask` auflösen (gleiche Priorität).
3. Wenn der Host `sandbox` ist, mit lokalem Sandbox-Exec fortfahren.
4. Wenn der Host `gateway` oder `node` ist, Sicherheits- und Ask-Richtlinie auf diesem Host anwenden.

## Standardsicherheit

- Standard `exec.host = sandbox`.
- Standard `exec.security = deny` für `gateway` und `node`.
- Standard `exec.ask = on-miss` (nur relevant, wenn die Sicherheit es erlaubt).
- Wenn keine Node-Bindung gesetzt ist, **kann der Agent jeden Node ansprechen**, jedoch nur, wenn die Richtlinie dies erlaubt.

## Konfigurationsoberfläche

### Tool-Parameter

- `exec.host` (optional): `sandbox | gateway | node`.
- `exec.security` (optional): `deny | allowlist | full`.
- `exec.ask` (optional): `off | on-miss | always`.
- `exec.node` (optional): zu verwendende Node-ID/-Name, wenn `host=node`.

### Konfigurationsschlüssel (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (Standard-Node-Bindung)

### Konfigurationsschlüssel (pro Agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = setzt `tools.exec.host=gateway`, `tools.exec.security=full` für die Agent-Sitzung.
- `/elevated off` = stellt vorherige Exec-Einstellungen für die Agent-Sitzung wieder her.

## Genehmigungsspeicher (JSON)

Pfad: `~/.openclaw/exec-approvals.json`

Zweck:

- Lokale Richtlinie + Allowlists für den **Ausführungs-Host** (Gateway oder Node-Runner).
- Ask-Fallback, wenn keine UI verfügbar ist.
- IPC-Zugangsdaten für UI-Clients.

Vorgeschlagenes Schema (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Hinweise:

- Keine Legacy-Allowlist-Formate.
- `askFallback` gilt nur, wenn `ask` erforderlich ist und keine UI erreichbar ist.
- Dateiberechtigungen: `0600`.

## Runner-Dienst (Headless)

### Rolle

- `exec.security` + `exec.ask` lokal durchsetzen.
- Systembefehle ausführen und Ausgabe zurückgeben.
- Bridge-Ereignisse für den Exec-Lebenszyklus ausgeben (optional, aber empfohlen).

### Dienstlebenszyklus

- Launchd/Daemon auf macOS; Systemdienst auf Linux/Windows.
- Genehmigungs-JSON ist lokal auf dem Ausführungs-Host.
- Die UI hostet einen lokalen Unix-Socket; Runner verbinden sich bei Bedarf.

## UI-Integration (macOS-App)

### IPC

- Unix-Socket unter `~/.openclaw/exec-approvals.sock` (0600).
- Token gespeichert in `exec-approvals.json` (0600).
- Peer-Checks: nur gleiche UID.
- Challenge/Response: Nonce + HMAC(token, request-hash) zur Verhinderung von Replay.
- Kurze TTL (z. B. 10 s) + maximale Payload + Rate-Limit.

### Ask-Ablauf (macOS-App-Exec-Host)

1. Node-Dienst empfängt `system.run` vom Gateway.
2. Node-Dienst verbindet sich mit dem lokalen Socket und sendet Prompt/Exec-Anfrage.
3. App validiert Peer + Token + HMAC + TTL und zeigt bei Bedarf einen Dialog.
4. App führt den Befehl im UI-Kontext aus und gibt die Ausgabe zurück.
5. Node-Dienst gibt die Ausgabe an das Gateway zurück.

Wenn die UI fehlt:

- `askFallback` anwenden (`deny|allowlist|full`).

### Diagramm (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node-Identität + Bindung

- Bestehendes `nodeId` aus dem Bridge-Pairing verwenden.
- Bindungsmodell:
  - `tools.exec.node` beschränkt den Agent auf einen bestimmten Node.
  - Wenn nicht gesetzt, kann der Agent jeden Node auswählen (Richtlinie erzwingt weiterhin Standards).
- Auflösung der Node-Auswahl:
  - `nodeId` exakte Übereinstimmung
  - `displayName` (normalisiert)
  - `remoteIp`
  - `nodeId` Präfix (≥ 6 Zeichen)

## Ereignisse

### Wer sieht Ereignisse

- Systemereignisse sind **pro Sitzung** und werden dem Agent beim nächsten Prompt angezeigt.
- Gespeichert in der Gateway-In-Memory-Queue (`enqueueSystemEvent`).

### Ereignistext

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + optionaler Ausgaben-Tail
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Option A (empfohlen):

- Runner sendet Bridge-`event`-Frames `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` mappt diese in `enqueueSystemEvent`.

Option B:

- Gateway-`exec`-Werkzeug verarbeitet den Lebenszyklus direkt (nur synchron).

## Exec-Flows

### Sandbox-Host

- Bestehendes `exec`-Verhalten (Docker oder Host, wenn nicht sandboxed).
- PTY nur im Nicht-Sandbox-Modus unterstützt.

### Gateway-Host

- Der Gateway-Prozess führt auf seiner eigenen Maschine aus.
- Erzwingt lokale `exec-approvals.json` (Sicherheit/Ask/Allowlist).

### Node-Host

- Gateway ruft `node.invoke` mit `system.run` auf.
- Runner erzwingt lokale Genehmigungen.
- Runner gibt aggregiertes stdout/stderr zurück.
- Optionale Bridge-Ereignisse für Start/Ende/Ablehnung.

## Ausgabe-Caps

- Kombiniertes stdout+stderr auf **200k** begrenzen; **Tail 20k** für Ereignisse behalten.
- Abbrechen mit einem klaren Suffix (z.B. `"… (truncated)"`).

## tools/slash-commands.md

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Pro Agent, pro Sitzung Überschreibungen; nicht persistent, sofern nicht per Konfiguration gespeichert.
- `/elevated on|off|ask|full` bleibt eine Abkürzung für `host=gateway security=full` (wobei `full` Genehmigungen überspringt).

## Plattformübergreifende Story

- Der Runner-Dienst ist das portable Ausführungsziel.
- UI ist optional; falls fehlend, gilt `askFallback`.
- Windows/Linux unterstützen dasselbe Genehmigungs-JSON + Socket-Protokoll.

## Implementierungsphasen

### Phase 1: Konfiguration + Exec-Routing

- Konfigurationsschema für `exec.host`, `exec.security`, `exec.ask`, `exec.node` hinzufügen.
- Tool-Plumbing aktualisieren, um `exec.host` zu berücksichtigen.
- `/exec`-Slash-Befehl hinzufügen und `/elevated`-Alias beibehalten.

### Phase 2: Genehmigungsspeicher + Gateway-Durchsetzung

- `exec-approvals.json`-Reader/Writer implementieren.
- Allowlist + Ask-Modi für den `gateway`-Host durchsetzen.
- Ausgabebegrenzungen hinzufügen.

### Phase 3: Node-Runner-Durchsetzung

- Node-Runner aktualisieren, um Allowlist + Ask durchzusetzen.
- Unix-Socket-Prompt-Brücke zur macOS-App-UI hinzufügen.
- `askFallback` verdrahten.

### Phase 4: Ereignisse

- Node → Gateway Bridge-Ereignisse für den Exec-Lebenszyklus hinzufügen.
- Zu `enqueueSystemEvent` für Agent-Prompts mappen.

### Phase 5: UI-Feinschliff

- Mac-App: Allowlist-Editor, Agent-spezifischer Umschalter, Ask-Richtlinien-UI.
- Node-Bindungssteuerungen (optional).

## Testplan

- Unit-Tests: Allowlist-Matching (Glob + Groß-/Kleinschreibung ignorierend).
- Unit-Tests: Priorität der Richtlinienauflösung (Tool-Parameter → Agent-Override → global).
- Integrationstests: Node-Runner Deny/Allow/Ask-Flows.
- Bridge-Ereignistests: Node-Ereignis → Systemereignis-Routing.

## Offene Risiken

- UI-Nichtverfügbarkeit: sicherstellen, dass `askFallback` beachtet wird.
- Lang laufende Befehle: auf Timeout + Ausgabebegrenzungen setzen.
- Mehrdeutigkeit bei mehreren Nodes: Fehler, sofern keine Node-Bindung oder expliziter Node-Parameter.

## Verwandte Dokumente

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
