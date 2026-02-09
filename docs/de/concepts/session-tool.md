---
summary: "„Agenten‑Sitzungswerkzeuge zum Auflisten von Sitzungen, Abrufen der Historie und Senden sitzungsübergreifender Nachrichten“"
read_when:
  - Hinzufügen oder Ändern von Sitzungswerkzeugen
title: "Sitzungswerkzeuge"
---

# Sitzungswerkzeuge

Ziel: kleines, schwer fehlzuverwendendes Werkzeugsatz, damit Agenten Sitzungen auflisten, die Historie abrufen und an eine andere Sitzung senden können.

## Werkzeugnamen

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Schlüsselmodell

- Der Haupt‑Direktchat‑Bucket ist immer der literale Schlüssel `"main"` (auf den Hauptschlüssel des aktuellen Agenten aufgelöst).
- Gruppenchats verwenden `agent:<agentId>:<channel>:group:<id>` oder `agent:<agentId>:<channel>:channel:<id>` (den vollständigen Schlüssel übergeben).
- Cron‑Jobs verwenden `cron:<job.id>`.
- Hooks verwenden `hook:<uuid>`, sofern nicht explizit gesetzt.
- Node‑Sitzungen verwenden `node-<nodeId>`, sofern nicht explizit gesetzt.

`global` und `unknown` sind reservierte Werte und werden niemals aufgelistet. Falls `session.scope = "global"`, aliasieren wir es für alle Werkzeuge auf `main`, sodass Aufrufer niemals `global` sehen.

## sessions_list

Listet Sitzungen als Array von Zeilen auf.

Parameter:

- `kinds?: string[]` Filter: einer aus `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` maximale Zeilen (Standard: Server‑Standard, Begrenzung z. B. 200)
- `activeMinutes?: number` nur Sitzungen, die innerhalb von N Minuten aktualisiert wurden
- `messageLimit?: number` 0 = keine Nachrichten (Standard 0); >0 = die letzten N Nachrichten einschließen

Verhalten:

- `messageLimit > 0` ruft `chat.history` pro Sitzung ab und schließt die letzten N Nachrichten ein.
- Werkzeugergebnisse werden in der Listenausgabe herausgefiltert; verwenden Sie `sessions_history` für Werkzeugnachrichten.
- Bei Ausführung in einer **sandboxed** Agenten‑Sitzung ist die Standardsichtbarkeit der Sitzungswerkzeuge **nur für gespawnte Sitzungen** (siehe unten).

Zeilenform (JSON):

- `key`: Sitzungsschlüssel (String)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (Gruppen‑Anzeigelabel, falls verfügbar)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (Sitzungs‑Override, falls gesetzt)
- `lastChannel`, `lastTo`
- `deliveryContext` (normalisiertes `{ channel, to, accountId }`, wenn verfügbar)
- `transcriptPath` (Best‑Effort‑Pfad, abgeleitet aus Store‑Verzeichnis + sessionId)
- `messages?` (nur wenn `messageLimit > 0`)

## sessions_history

Abrufen des Transkripts für eine Sitzung.

Parameter:

- `sessionKey` (erforderlich; akzeptiert Sitzungsschlüssel oder `sessionId` aus `sessions_list`)
- `limit?: number` maximale Nachrichten (Server begrenzt)
- `includeTools?: boolean` (Standard false)

Verhalten:

- `includeTools=false` filtert `role: "toolResult"`‑Nachrichten.
- Gibt ein Nachrichten‑Array im rohen Transkriptformat zurück.
- Bei Angabe einer `sessionId` löst OpenClaw diese auf den entsprechenden Sitzungsschlüssel auf (Fehler bei fehlenden IDs).

## sessions_send

Sendet eine Nachricht in eine andere Sitzung.

Parameter:

- `sessionKey` (erforderlich; akzeptiert Sitzungsschlüssel oder `sessionId` aus `sessions_list`)
- `message` (erforderlich)
- `timeoutSeconds?: number` (Standard >0; 0 = Fire‑and‑Forget)

Verhalten:

- `timeoutSeconds = 0`: einreihen und `{ runId, status: "accepted" }` zurückgeben.
- `timeoutSeconds > 0`: bis zu N Sekunden auf Abschluss warten und dann `{ runId, status: "ok", reply }` zurückgeben.
- Bei Timeout der Wartezeit: `{ runId, status: "timeout", error }`. Der Lauf wird fortgesetzt; rufen Sie `sessions_history` später auf.
- Scheitert der Lauf: `{ runId, status: "error", error }`.
- Zustellungs‑Ankündigungsläufe erfolgen nach Abschluss des Primärlaufs und sind Best‑Effort; `status: "ok"` garantiert nicht, dass die Ankündigung zugestellt wurde.
- Wartet über Gateway `agent.wait` (serverseitig), sodass Reconnects das Warten nicht abbrechen.
- Agent‑zu‑Agent‑Nachrichtenkontext wird für den Primärlauf injiziert.
- Nach Abschluss des Primärlaufs führt OpenClaw eine **Reply‑Back‑Schleife** aus:
  - Runde 2+ alterniert zwischen anforderndem und Ziel‑Agenten.
  - Antworten Sie exakt `REPLY_SKIP`, um das Ping‑Pong zu stoppen.
  - Maximale Züge: `session.agentToAgent.maxPingPongTurns` (0–5, Standard 5).
- Sobald die Schleife endet, führt OpenClaw den **Agent‑zu‑Agent‑Ankündigungsschritt** aus (nur Ziel‑Agent):
  - Antworten Sie exakt `ANNOUNCE_SKIP`, um stumm zu bleiben.
  - Jede andere Antwort wird an den Zielkanal gesendet.
  - Der Ankündigungsschritt enthält die ursprüngliche Anfrage + Antwort aus Runde 1 + die letzte Ping‑Pong‑Antwort.

## Kanal‑Feld

- Für Gruppen ist `channel` der im Sitzungseintrag erfasste Kanal.
- Für Direktchats wird `channel` aus `lastChannel` abgebildet.
- Für Cron/Hook/Node ist `channel` gleich `internal`.
- Falls fehlend, ist `channel` gleich `unknown`.

## Sicherheit / Send‑Richtlinie

Richtlinienbasiertes Blockieren nach Kanal‑/Chat‑Typ (nicht pro Sitzungs‑ID).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Laufzeit‑Override (pro Sitzungseintrag):

- `sendPolicy: "allow" | "deny"` (nicht gesetzt = Konfiguration erben)
- Setzbar über `sessions.patch` oder owner‑only `/send on|off|inherit` (Standalone‑Nachricht).

Durchsetzungspunkte:

- `chat.send` / `agent` (Gateway)
- Auto‑Reply‑Zustelllogik

## sessions_spawn

Startet einen Sub‑Agent‑Lauf in einer isolierten Sitzung und kündigt das Ergebnis im anfordernden Chat‑Kanal an.

Parameter:

- `task` (erforderlich)
- `label?` (optional; für Logs/UI verwendet)
- `agentId?` (optional; unter einer anderen Agent‑ID starten, falls erlaubt)
- `model?` (optional; überschreibt das Sub‑Agent‑Modell; ungültige Werte führen zu Fehlern)
- `runTimeoutSeconds?` (Standard 0; wenn gesetzt, wird der Sub‑Agent‑Lauf nach N Sekunden abgebrochen)
- `cleanup?` (`delete|keep`, Standard `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: Liste der Agent‑IDs, die über `agentId` erlaubt sind (`["*"]` erlaubt alle). Standard: nur der anfordernde Agent.

Discovery:

- Verwenden Sie `agents_list`, um zu ermitteln, welche Agent‑IDs für `sessions_spawn` erlaubt sind.

Verhalten:

- Startet eine neue `agent:<agentId>:subagent:<uuid>`‑Sitzung mit `deliver: false`.
- Sub‑Agenten verwenden standardmäßig den vollständigen Werkzeugsatz **ohne Sitzungswerkzeuge** (konfigurierbar über `tools.subagents.tools`).
- Sub‑Agenten dürfen `sessions_spawn` nicht aufrufen (kein Sub‑Agent → Sub‑Agent‑Spawning).
- Immer nicht blockierend: gibt `{ status: "accepted", runId, childSessionKey }` sofort zurück.
- Nach Abschluss führt OpenClaw einen Sub‑Agent‑**Ankündigungsschritt** aus und postet das Ergebnis in den anfordernden Chat‑Kanal.
- Antworten Sie im Ankündigungsschritt exakt `ANNOUNCE_SKIP`, um stumm zu bleiben.
- Ankündigungsantworten werden auf `Status`/`Result`/`Notes` normalisiert; `Status` stammt aus dem Laufzeitergebnis (nicht aus dem Modelltext).
- Sub‑Agent‑Sitzungen werden nach `agents.defaults.subagents.archiveAfterMinutes` automatisch archiviert (Standard: 60).
- Ankündigungsantworten enthalten eine Statistikzeile (Laufzeit, Tokens, sessionKey/sessionId, Transkriptpfad und optionale Kosten).

## Sandbox‑Sitzungssichtbarkeit

Sandboxed‑Sitzungen können Sitzungswerkzeuge verwenden, sehen standardmäßig jedoch nur Sitzungen, die sie über `sessions_spawn` gestartet haben.

Konfiguration:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
