---
summary: "„Lebenszyklus der Agenten-Schleife, Streams und Warte-Semantik“"
read_when:
  - Sie benötigen eine exakte Schritt-für-Schritt-Erklärung der Agenten-Schleife oder der Lebenszyklusereignisse
title: "„Agenten-Schleife“"
---

# Agenten-Schleife (OpenClaw)

Eine agentische Schleife ist der vollständige „echte“ Lauf eines Agenten: Intake → Kontextaufbau → Modellinferenz →
Werkzeugausführung → Streaming-Antworten → Persistenz. Sie ist der maßgebliche Pfad, der eine Nachricht
in Aktionen und eine finale Antwort umsetzt und dabei den Sitzungszustand konsistent hält.

In OpenClaw ist eine Schleife ein einzelner, serialisierter Lauf pro Sitzung, der Lebenszyklus- und Stream-Ereignisse
emittiert, während das Modell denkt, Werkzeuge aufruft und Ausgaben streamt. Dieses Dokument erklärt, wie diese
authentische Schleife Ende-zu-Ende verdrahtet ist.

## Einstiegspunkte

- Gateway-RPC: `agent` und `agent.wait`.
- CLI: Befehl `agent`.

## Funktionsweise (High-Level)

1. `agent` RPC validiert Parameter, löst die Sitzung (sessionKey/sessionId) auf, persistiert Sitzungsmetadaten und gibt sofort `{ runId, acceptedAt }` zurück.
2. `agentCommand` führt den Agenten aus:
   - löst Modell- sowie Thinking-/Verbose-Standards auf
   - lädt den Skills-Snapshot
   - ruft `runEmbeddedPiAgent` (pi-agent-core Runtime) auf
   - emittiert **Lifecycle end/error**, falls die eingebettete Schleife keines emittiert
3. `runEmbeddedPiAgent`:
   - serialisiert Läufe über pro-Sitzungs- und globale Queues
   - löst Modell- und Auth-Profil auf und baut die pi-Sitzung
   - abonniert pi-Ereignisse und streamt Assistant-/Tool-Deltas
   - erzwingt Timeouts → bricht den Lauf bei Überschreitung ab
   - gibt Payloads + Nutzungsmetadaten zurück
4. `subscribeEmbeddedPiSession` überbrückt pi-agent-core-Ereignisse in den OpenClaw-`agent`-Stream:
   - Tool-Ereignisse ⇒ `stream: "tool"`
   - Assistant-Deltas ⇒ `stream: "assistant"`
   - Lifecycle-Ereignisse ⇒ `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` verwendet `waitForAgentJob`:
   - wartet auf **Lifecycle end/error** für `runId`
   - gibt `{ status: ok|error|timeout, startedAt, endedAt, error? }` zurück

## Queueing + Nebenläufigkeit

- Läufe werden pro Sitzungsschlüssel (Session-Lane) und optional über eine globale Lane serialisiert.
- Dies verhindert Tool-/Sitzungs-Rennen und hält die Sitzungshistorie konsistent.
- Messaging-Kanäle können Queue-Modi (collect/steer/followup) wählen, die dieses Lane-System speisen.
  Siehe [Command Queue](/concepts/queue).

## Sitzung + Workspace-Vorbereitung

- Der Workspace wird aufgelöst und erstellt; sandboxed Läufe können zu einer Sandbox-Workspace-Root umleiten.
- Skills werden geladen (oder aus einem Snapshot wiederverwendet) und in Umgebung und Prompt injiziert.
- Bootstrap-/Kontextdateien werden aufgelöst und in den System-Prompt-Report injiziert.
- Eine Sitzungs-Schreibsperre wird erworben; `SessionManager` wird vor dem Streaming geöffnet und vorbereitet.

## Prompt-Zusammenbau + System-Prompt

- Der System-Prompt wird aus dem Basis-Prompt von OpenClaw, dem Skills-Prompt, dem Bootstrap-Kontext und pro Lauf-Overrides aufgebaut.
- Modellspezifische Limits und Reserve-Tokens für Kompaktierung werden erzwungen.
- Siehe [System prompt](/concepts/system-prompt) für das, was das Modell sieht.

## Hook-Punkte (wo Sie abfangen können)

OpenClaw hat zwei Hook-Systeme:

- **Interne Hooks** (Gateway-Hooks): ereignisgetriebene Skripte für Befehle und Lifecycle-Ereignisse.
- **Plugin-Hooks**: Erweiterungspunkte innerhalb des Agenten-/Tool-Lebenszyklus und der Gateway-Pipeline.

### Interne Hooks (Gateway-Hooks)

- **`agent:bootstrap`**: läuft beim Erstellen der Bootstrap-Dateien, bevor der System-Prompt finalisiert wird.
  Verwenden Sie dies, um Bootstrap-Kontextdateien hinzuzufügen/zu entfernen.
- **Command-Hooks**: `/new`, `/reset`, `/stop` und weitere Befehlsevents (siehe Hooks-Dokument).

Siehe [Hooks](/automation/hooks) für Einrichtung und Beispiele.

### Plugin-Hooks (Agenten- + Gateway-Lebenszyklus)

Diese laufen innerhalb der Agenten-Schleife oder der Gateway-Pipeline:

- **`before_agent_start`**: injiziert Kontext oder überschreibt den System-Prompt vor Start des Laufs.
- **`agent_end`**: inspiziert die finale Nachrichtenliste und Laufmetadaten nach Abschluss.
- **`before_compaction` / `after_compaction`**: beobachtet oder annotiert Kompaktierungszyklen.
- **`before_tool_call` / `after_tool_call`**: fängt Tool-Parameter/-Ergebnisse ab.
- **`tool_result_persist`**: transformiert Tool-Ergebnisse synchron, bevor sie in das Sitzungsprotokoll geschrieben werden.
- **`message_received` / `message_sending` / `message_sent`**: eingehende + ausgehende Nachrichten-Hooks.
- **`session_start` / `session_end`**: Grenzen des Sitzungs-Lebenszyklus.
- **`gateway_start` / `gateway_stop`**: Gateway-Lebenszyklusereignisse.

Siehe [Plugins](/tools/plugin#plugin-hooks) für die Hook-API und Registrierungsdetails.

## Streaming + Teilantworten

- Assistant-Deltas werden aus pi-agent-core gestreamt und als `assistant`-Ereignisse emittiert.
- Block-Streaming kann Teilantworten entweder auf `text_end` oder `message_end` emittieren.
- Reasoning-Streaming kann als separater Stream oder als Block-Antworten emittiert werden.
- Siehe [Streaming](/concepts/streaming) für Chunking- und Block-Antwort-Verhalten.

## Werkzeugausführung + Messaging-Werkzeuge

- Tool-Start-/Update-/Ende-Ereignisse werden auf dem `tool`-Stream emittiert.
- Tool-Ergebnisse werden vor dem Protokollieren/Emittieren hinsichtlich Größe und Bild-Payloads bereinigt.
- Messaging-Tool-Sendungen werden verfolgt, um doppelte Assistant-Bestätigungen zu unterdrücken.

## Antwortformung + Unterdrückung

- Finale Payloads werden zusammengestellt aus:
  - Assistant-Text (und optional Reasoning)
  - Inline-Tool-Zusammenfassungen (bei verbose + erlaubt)
  - Assistant-Fehlertext, wenn das Modell einen Fehler hat
- `NO_REPLY` wird als stilles Token behandelt und aus ausgehenden Payloads gefiltert.
- Duplikate von Messaging-Tools werden aus der finalen Payload-Liste entfernt.
- Wenn keine darstellbaren Payloads verbleiben und ein Tool einen Fehler hatte, wird eine Fallback-Tool-Fehlerantwort emittiert
  (es sei denn, ein Messaging-Tool hat bereits eine für Nutzer sichtbare Antwort gesendet).

## Kompaktierung + Wiederholungen

- Auto-Kompaktierung emittiert `compaction`-Stream-Ereignisse und kann eine Wiederholung auslösen.
- Bei einer Wiederholung werden In-Memory-Puffer und Tool-Zusammenfassungen zurückgesetzt, um doppelte Ausgabe zu vermeiden.
- Siehe [Compaction](/concepts/compaction) für die Kompaktierungs-Pipeline.

## Ereignis-Streams (heute)

- `lifecycle`: emittiert von `subscribeEmbeddedPiSession` (und als Fallback von `agentCommand`)
- `assistant`: gestreamte Deltas aus pi-agent-core
- `tool`: gestreamte Tool-Ereignisse aus pi-agent-core

## Chat-Kanal-Verarbeitung

- Assistant-Deltas werden in Chat-`delta`-Nachrichten gepuffert.
- Eine Chat-`final` wird bei **Lifecycle end/error** emittiert.

## Timeouts

- `agent.wait` Standard: 30 s (nur das Warten). `timeoutMs`-Parameter überschreibt.
- Agenten-Runtime: `agents.defaults.timeoutSeconds` Standard 600 s; erzwungen im `runEmbeddedPiAgent`-Abbruch-Timer.

## Wo Dinge frühzeitig enden können

- Agenten-Timeout (Abbruch)
- AbortSignal (Abbrechen)
- Gateway-Trennung oder RPC-Timeout
- `agent.wait`-Timeout (nur Warten, stoppt den Agenten nicht)
