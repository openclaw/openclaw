---
summary: "Deep Dive: Session-Store + Transkripte, Lebenszyklus und (Auto-)Kompaktions-Interna"
read_when:
  - Sie müssen Session-IDs, Transcript-JSONL oder Felder in sessions.json debuggen
  - Sie ändern das Auto-Kompaktionsverhalten oder fügen „Pre-Compaction“-Housekeeping hinzu
  - Sie möchten Memory-Flushes oder stille System-Turns implementieren
title: "Session-Management – Deep Dive"
---

# Session-Management & Kompaktierung (Deep Dive)

Dieses Dokument erläutert, wie OpenClaw Sessions Ende-zu-Ende verwaltet:

- **Session-Routing** (wie eingehende Nachrichten einem `sessionKey` zugeordnet werden)
- **Session-Store** (`sessions.json`) und was er erfasst
- **Transkript-Persistenz** (`*.jsonl`) und ihre Struktur
- **Transkript-Hygiene** (anbieter­spezifische Korrekturen vor Läufen)
- **Kontextlimits** (Kontextfenster vs. erfasste Tokens)
- **Kompaktierung** (manuell + Auto-Kompaktierung) und wo Vorarbeiten vor der Kompaktierung einzuhängen sind
- **Stilles Housekeeping** (z. B. Speicher-Schreibvorgänge, die keine nutzer­sichtbare Ausgabe erzeugen sollen)

Wenn Sie zunächst eine Übersicht auf höherer Ebene wünschen, beginnen Sie mit:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Quelle der Wahrheit: das Gateway

OpenClaw ist um einen einzelnen **Gateway-Prozess** herum konzipiert, der den Session-Status besitzt.

- UIs (macOS-App, Web-Control-UI, TUI) sollten das Gateway nach Session-Listen und Token-Zählungen abfragen.
- Im Remote-Modus liegen Session-Dateien auf dem Remote-Host; ein „Prüfen Ihrer lokalen Mac-Dateien“ spiegelt nicht wider, was das Gateway verwendet.

---

## Zwei Persistenzschichten

OpenClaw persistiert Sessions in zwei Schichten:

1. **Session-Store (`sessions.json`)**
   - Key/Value-Map: `sessionKey -> SessionEntry`
   - Klein, veränderlich, sicher zu bearbeiten (oder Einträge zu löschen)
   - Erfasst Session-Metadaten (aktuelle Session-ID, letzte Aktivität, Toggles, Token-Zähler usw.)

2. **Transkript (`<sessionId>.jsonl`)**
   - Append-only-Transkript mit Baumstruktur (Einträge haben `id` + `parentId`)
   - Speichert die eigentliche Konversation + Tool-Aufrufe + Kompaktierungszusammenfassungen
   - Wird verwendet, um den Modellkontext für zukünftige Turns neu aufzubauen

---

## Ablageorte auf Datenträger

Pro Agent, auf dem Gateway-Host:

- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transkripte: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram-Themen-Sessions: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw löst diese über `src/config/sessions.ts` auf.

---

## Session-Schlüssel (`sessionKey`)

Ein `sessionKey` identifiziert, _in welchem Konversations-Bucket_ Sie sich befinden (Routing + Isolation).

Gängige Muster:

- Haupt-/Direktchat (pro Agent): `agent:<agentId>:<mainKey>` (Standard `main`)
- Gruppe: `agent:<agentId>:<channel>:group:<id>`
- Raum/Kanal (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` oder `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (sofern nicht überschrieben)

Die kanonischen Regeln sind unter [/concepts/session](/concepts/session) dokumentiert.

---

## Session-IDs (`sessionId`)

Jeder `sessionKey` verweist auf eine aktuelle `sessionId` (die Transkriptdatei, die die Konversation fortsetzt).

Faustregeln:

- **Reset** (`/new`, `/reset`) erstellt eine neue `sessionId` für diesen `sessionKey`.
- **Täglicher Reset** (Standard 4:00 Uhr Ortszeit auf dem Gateway-Host) erstellt eine neue `sessionId` bei der nächsten Nachricht nach der Reset-Grenze.
- **Leerlaufablauf** (`session.reset.idleMinutes` oder legacy `session.idleMinutes`) erstellt eine neue `sessionId`, wenn nach dem Leerlauffenster eine Nachricht eintrifft. Wenn täglich + Leerlauf beide konfiguriert sind, gewinnt der zuerst ablaufende.

Implementierungsdetail: Die Entscheidung erfolgt in `initSessionState()` in `src/auto-reply/reply/session.ts`.

---

## Schema des Session-Stores (`sessions.json`)

Der Werttyp des Stores ist `SessionEntry` in `src/config/sessions.ts`.

Wichtige Felder (nicht vollständig):

- `sessionId`: aktuelle Transkript-ID (Dateiname wird hiervon abgeleitet, sofern `sessionFile` nicht gesetzt ist)
- `updatedAt`: Zeitstempel der letzten Aktivität
- `sessionFile`: optionale explizite Überschreibung des Transkriptpfads
- `chatType`: `direct | group | room` (hilft UIs und der Sende-Policy)
- `provider`, `subject`, `room`, `space`, `displayName`: Metadaten für Gruppen-/Kanalbeschriftung
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (Override pro Session)
- Modellauswahl:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Token-Zähler (Best-Effort / anbieterabhängig):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: wie oft die Auto-Kompaktierung für diesen Session-Schlüssel abgeschlossen wurde
- `memoryFlushAt`: Zeitstempel des letzten Pre-Kompaktions-Memory-Flush
- `memoryFlushCompactionCount`: Kompaktierungszähler beim letzten Flush

Der Store ist sicher zu bearbeiten, aber das Gateway ist die Autorität: Es kann Einträge beim Ausführen von Sessions neu schreiben oder rehydrieren.

---

## Transkriptstruktur (`*.jsonl`)

Transkripte werden von `@mariozechner/pi-coding-agent`’s `SessionManager` verwaltet.

Die Datei ist JSONL:

- Erste Zeile: Session-Header (`type: "session"`, enthält `id`, `cwd`, `timestamp`, optional `parentSession`)
- Danach: Session-Einträge mit `id` + `parentId` (Baum)

Bemerkenswerte Eintragstypen:

- `message`: user/assistant/toolResult-Nachrichten
- `custom_message`: von Extensions injizierte Nachrichten, die _in_ den Modellkontext eingehen (können in der UI verborgen sein)
- `custom`: Extension-Status, der _nicht_ in den Modellkontext eingeht
- `compaction`: persistierte Kompaktierungszusammenfassung mit `firstKeptEntryId` und `tokensBefore`
- `branch_summary`: persistierte Zusammenfassung beim Navigieren eines Baumzweigs

OpenClaw „korrigiert“ Transkripte absichtlich **nicht**; das Gateway verwendet `SessionManager` zum Lesen/Schreiben.

---

## Kontextfenster vs. erfasste Tokens

Zwei unterschiedliche Konzepte sind relevant:

1. **Modell-Kontextfenster**: harte Obergrenze pro Modell (für das Modell sichtbare Tokens)
2. **Session-Store-Zähler**: rollierende Statistiken, die in `sessions.json` geschrieben werden (verwendet für /status und Dashboards)

Wenn Sie Limits feinjustieren:

- Das Kontextfenster stammt aus dem Modellkatalog (und kann per Konfiguration überschrieben werden).
- `contextTokens` im Store ist ein Laufzeit-Schätzwert für Reporting; behandeln Sie ihn nicht als strikte Garantie.

Weitere Details unter [/token-use](/reference/token-use).

---

## Kompaktierung: was sie ist

Kompaktierung fasst ältere Konversationen in einen persistierten `compaction`-Eintrag im Transkript zusammen und belässt aktuelle Nachrichten unverändert.

Nach der Kompaktierung sehen zukünftige Turns:

- Die Kompaktierungszusammenfassung
- Nachrichten nach `firstKeptEntryId`

Kompaktierung ist **persistent** (im Gegensatz zum Session-Pruning). Siehe [/concepts/session-pruning](/concepts/session-pruning).

---

## Wann Auto-Kompaktierung stattfindet (Pi-Runtime)

Im eingebetteten Pi-Agenten wird die Auto-Kompaktierung in zwei Fällen ausgelöst:

1. **Overflow-Recovery**: Das Modell liefert einen Kontext-Overflow-Fehler → komprimieren → erneut versuchen.
2. **Schwellenwert-Wartung**: nach einem erfolgreichen Turn, wenn:

`contextTokens > contextWindow - reserveTokens`

Dabei gilt:

- `contextWindow` ist das Kontextfenster des Modells
- `reserveTokens` ist der reservierte Puffer für Prompts + die nächste Modellausgabe

Dies sind Semantiken der Pi-Runtime (OpenClaw konsumiert die Events, aber Pi entscheidet, wann komprimiert wird).

---

## Kompaktierungseinstellungen (`reserveTokens`, `keepRecentTokens`)

Pis Kompaktierungseinstellungen befinden sich in den Pi-Einstellungen:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw erzwingt außerdem einen Sicherheits-Mindestwert für eingebettete Läufe:

- Wenn `compaction.reserveTokens < reserveTokensFloor`, erhöht OpenClaw diesen.
- Standard-Mindestwert sind `20000` Tokens.
- Setzen Sie `agents.defaults.compaction.reserveTokensFloor: 0`, um den Mindestwert zu deaktivieren.
- Ist er bereits höher, lässt OpenClaw ihn unverändert.

Warum: genügend Puffer für mehrturniges „Housekeeping“ (wie Memory-Schreibvorgänge) lassen, bevor Kompaktierung unvermeidlich wird.

Implementierung: `ensurePiCompactionReserveTokens()` in `src/agents/pi-settings.ts`
(aufgerufen von `src/agents/pi-embedded-runner.ts`).

---

## Nutzer­sichtbare Oberflächen

Sie können Kompaktierung und Session-Status beobachten über:

- `/status` (in jeder Chat-Session)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose-Modus: `🧹 Auto-compaction complete` + Kompaktierungszähler

---

## Stilles Housekeeping (`NO_REPLY`)

OpenClaw unterstützt „stille“ Turns für Hintergrundaufgaben, bei denen der Nutzer keine Zwischenausgaben sehen soll.

Konvention:

- Der Assistent beginnt seine Ausgabe mit `NO_REPLY`, um „keine Antwort an den Nutzer ausliefern“ zu signalisieren.
- OpenClaw entfernt/unterdrückt dies in der Auslieferungsschicht.

Seit `2026.1.10` unterdrückt OpenClaw außerdem **Draft/Typing-Streaming**, wenn ein partieller Chunk mit `NO_REPLY` beginnt, sodass stille Operationen keine Teilausgaben während des Turns preisgeben.

---

## Pre-Kompaktions-„Memory-Flush“ (implementiert)

Ziel: Bevor Auto-Kompaktierung stattfindet, einen stillen agentischen Turn ausführen, der dauerhaften Zustand auf Datenträger schreibt (z. B. `memory/YYYY-MM-DD.md` im Agent-Workspace), damit Kompaktierung keinen kritischen Kontext löschen kann.

OpenClaw verwendet den Ansatz des **Pre-Threshold-Flush**:

1. Überwachen der Session-Kontextnutzung.
2. Beim Überschreiten einer „Soft-Schwelle“ (unterhalb von Pis Kompaktierungsschwelle) einen stillen
   „Jetzt Speicher schreiben“-Befehl an den Agenten ausführen.
3. `NO_REPLY` verwenden, sodass der Nutzer nichts sieht.

Konfiguration (`agents.defaults.compaction.memoryFlush`):

- `enabled` (Standard: `true`)
- `softThresholdTokens` (Standard: `4000`)
- `prompt` (User-Nachricht für den Flush-Turn)
- `systemPrompt` (zusätzlicher System-Prompt, der für den Flush-Turn angehängt wird)

Hinweise:

- Der Standard-Prompt/System-Prompt enthält einen `NO_REPLY`-Hinweis zur Unterdrückung der Auslieferung.
- Der Flush läuft einmal pro Kompaktierungszyklus (nachverfolgt in `sessions.json`).
- Der Flush läuft nur für eingebettete Pi-Sessions (CLI-Backends überspringen ihn).
- Der Flush wird übersprungen, wenn der Session-Workspace schreibgeschützt ist (`workspaceAccess: "ro"` oder `"none"`).
- Siehe [Memory](/concepts/memory) für das Layout der Workspace-Dateien und Schreibmuster.

Pi stellt außerdem einen `session_before_compact`-Hook in der Extension-API bereit, aber OpenClaws
Flush-Logik befindet sich heute auf der Gateway-Seite.

---

## Checkliste zur Fehlerbehebung

- Session-Schlüssel falsch? Beginnen Sie mit [/concepts/session](/concepts/session) und bestätigen Sie den `sessionKey` in `/status`.
- Store vs. Transkript inkonsistent? Bestätigen Sie den Gateway-Host und den Store-Pfad aus `openclaw status`.
- Kompaktierungs-Spam? Prüfen Sie:
  - Modell-Kontextfenster (zu klein)
  - Kompaktierungseinstellungen (`reserveTokens` zu hoch für das Modellfenster kann frühere Kompaktierung verursachen)
  - Tool-Result-Aufblähung: Session-Pruning aktivieren/feinjustieren
- Stille Turns lecken? Bestätigen Sie, dass die Antwort mit `NO_REPLY` (exaktes Token) beginnt und Sie eine Build-Version mit dem Streaming-Unterdrückungs-Fix verwenden.
