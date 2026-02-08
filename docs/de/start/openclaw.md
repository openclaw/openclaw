---
summary: „End-to-End-Leitfaden zum Ausführen von OpenClaw als persönlicher Assistent mit Sicherheitshinweisen“
read_when:
  - Onboarding einer neuen Assistenteninstanz
  - Überprüfung von Sicherheits- und Berechtigungsimplikationen
title: „Einrichtung eines persönlichen Assistenten“
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:32Z
---

# Aufbau eines persönlichen Assistenten mit OpenClaw

OpenClaw ist ein WhatsApp‑, Telegram‑, Discord‑ und iMessage‑Gateway für **Pi**‑Agenten. Plugins fügen Mattermost hinzu. Dieser Leitfaden beschreibt die Einrichtung als „persönlichen Assistenten“: eine dedizierte WhatsApp‑Nummer, die sich wie Ihr stets aktiver Agent verhält.

## ⚠️ Sicherheit zuerst

Sie bringen einen Agenten in die Lage:

- Befehle auf Ihrer Maschine auszuführen (abhängig von Ihrer Pi‑Werkzeug‑Konfiguration)
- Dateien in Ihrem Workspace zu lesen/schreiben
- Nachrichten über WhatsApp/Telegram/Discord/Mattermost (Plugin) nach außen zu senden

Beginnen Sie konservativ:

- Setzen Sie immer `channels.whatsapp.allowFrom` (betreiben Sie Ihren persönlichen Mac niemals offen im Internet).
- Verwenden Sie eine dedizierte WhatsApp‑Nummer für den Assistenten.
- Heartbeats sind jetzt standardmäßig alle 30 Minuten aktiv. Deaktivieren Sie sie, bis Sie der Einrichtung vertrauen, indem Sie `agents.defaults.heartbeat.every: "0m"` setzen.

## Voraussetzungen

- OpenClaw installiert und onboarded — siehe [Erste Schritte](/start/getting-started), falls Sie dies noch nicht erledigt haben
- Eine zweite Telefonnummer (SIM/eSIM/Prepaid) für den Assistenten

## Das Zwei‑Telefon‑Setup (empfohlen)

Das möchten Sie:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Wenn Sie Ihr persönliches WhatsApp mit OpenClaw verknüpfen, wird jede Nachricht an Sie zu „Agent‑Input“. Das ist selten gewünscht.

## 5‑Minuten‑Schnellstart

1. WhatsApp Web koppeln (zeigt QR; mit dem Assistenten‑Telefon scannen):

```bash
openclaw channels login
```

2. Das Gateway starten (laufen lassen):

```bash
openclaw gateway --port 18789
```

3. Eine minimale Konfiguration in `~/.openclaw/openclaw.json` ablegen:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Schreiben Sie nun von Ihrem allowlisteten Telefon an die Assistenten‑Nummer.

Wenn das Onboarding abgeschlossen ist, öffnen wir automatisch das Dashboard und geben einen sauberen (nicht tokenisierten) Link aus. Falls zur Authentifizierung aufgefordert wird, fügen Sie den Token aus `gateway.auth.token` in die Control‑UI‑Einstellungen ein. Später erneut öffnen: `openclaw dashboard`.

## Dem Agenten einen Workspace geben (AGENTS)

OpenClaw liest Betriebsanweisungen und „Gedächtnis“ aus seinem Workspace‑Verzeichnis.

Standardmäßig verwendet OpenClaw `~/.openclaw/workspace` als Agent‑Workspace und erstellt dieses (sowie die Startdateien `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatisch beim Setup/ersten Agentenlauf. `BOOTSTRAP.md` wird nur erstellt, wenn der Workspace brandneu ist (er sollte nach dem Löschen nicht zurückkehren). `MEMORY.md` ist optional (wird nicht automatisch erstellt); ist sie vorhanden, wird sie für normale Sitzungen geladen. Subagent‑Sitzungen injizieren nur `AGENTS.md` und `TOOLS.md`.

Tipp: Behandeln Sie diesen Ordner wie das „Gedächtnis“ von OpenClaw und machen Sie ihn zu einem Git‑Repository (idealerweise privat), damit Ihre `AGENTS.md`‑ und Gedächtnisdateien gesichert sind. Wenn Git installiert ist, werden brandneue Workspaces automatisch initialisiert.

```bash
openclaw setup
```

Vollständiges Workspace‑Layout + Backup‑Leitfaden: [Agent‑Workspace](/concepts/agent-workspace)  
Gedächtnis‑Workflow: [Gedächtnis](/concepts/memory)

Optional: Wählen Sie einen anderen Workspace mit `agents.defaults.workspace` (unterstützt `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Wenn Sie bereits eigene Workspace‑Dateien aus einem Repository ausliefern, können Sie die Erstellung der Bootstrap‑Dateien vollständig deaktivieren:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Die Konfiguration, die daraus „einen Assistenten“ macht

OpenClaw bringt standardmäßig eine gute Assistenten‑Konfiguration mit, aber in der Regel möchten Sie Folgendes anpassen:

- Persona/Anweisungen in `SOUL.md`
- Denk‑Voreinstellungen (falls gewünscht)
- Heartbeats (sobald Sie dem System vertrauen)

Beispiel:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sitzungen und Gedächtnis

- Sitzungsdateien: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Sitzungsmetadaten (Token‑Nutzung, letzte Route usw.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (Legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` oder `/reset` startet für diesen Chat eine frische Sitzung (konfigurierbar über `resetTriggers`). Wird es allein gesendet, antwortet der Agent mit einem kurzen Hallo zur Bestätigung des Resets.
- `/compact [instructions]` kompaktiert den Sitzungs‑Kontext und meldet das verbleibende Kontext‑Budget.

## Heartbeats (proaktiver Modus)

Standardmäßig führt OpenClaw alle 30 Minuten einen Heartbeat mit dem Prompt aus:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Setzen Sie `agents.defaults.heartbeat.every: "0m"`, um ihn zu deaktivieren.

- Existiert `HEARTBEAT.md`, ist aber faktisch leer (nur Leerzeilen und Markdown‑Überschriften wie `# Heading`), überspringt OpenClaw den Heartbeat‑Lauf, um API‑Aufrufe zu sparen.
- Fehlt die Datei, läuft der Heartbeat trotzdem und das Modell entscheidet, was zu tun ist.
- Antwortet der Agent mit `HEARTBEAT_OK` (optional mit kurzem Padding; siehe `agents.defaults.heartbeat.ackMaxChars`), unterdrückt OpenClaw die ausgehende Zustellung für diesen Heartbeat.
- Heartbeats sind vollständige Agenten‑Züge — kürzere Intervalle verbrauchen mehr Tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Medien rein und raus

Eingehende Anhänge (Bilder/Audio/Dokumente) können Ihrem Befehl über Templates bereitgestellt werden:

- `{{MediaPath}}` (lokaler temporärer Dateipfad)
- `{{MediaUrl}}` (Pseudo‑URL)
- `{{Transcript}}` (falls Audio‑Transkription aktiviert ist)

Ausgehende Anhänge vom Agenten: Fügen Sie `MEDIA:<path-or-url>` in einer eigenen Zeile ein (keine Leerzeichen). Beispiel:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw extrahiert diese und sendet sie als Medien zusammen mit dem Text.

## Betriebs‑Checkliste

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Logs befinden sich unter `/tmp/openclaw/` (Standard: `openclaw-YYYY-MM-DD.log`).

## Nächste Schritte

- WebChat: [WebChat](/web/webchat)
- Gateway‑Betrieb: [Gateway‑Runbook](/gateway)
- Cron + Wakeups: [Cron‑Jobs](/automation/cron-jobs)
- macOS‑Menüleisten‑Begleiter: [OpenClaw macOS app](/platforms/macos)
- iOS‑Node‑App: [iOS app](/platforms/ios)
- Android‑Node‑App: [Android app](/platforms/android)
- Windows‑Status: [Windows (WSL2)](/platforms/windows)
- Linux‑Status: [Linux app](/platforms/linux)
- Sicherheit: [Security](/gateway/security)
