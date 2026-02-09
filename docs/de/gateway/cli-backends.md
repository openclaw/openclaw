---
summary: "CLI-Backends: textbasierter Fallback über lokale KI-CLIs"
read_when:
  - Sie möchten einen zuverlässigen Fallback, wenn API-Anbieter ausfallen
  - Sie betreiben Claude Code CLI oder andere lokale KI-CLIs und möchten diese wiederverwenden
  - Sie benötigen einen rein textbasierten, werkzeugfreien Pfad, der dennoch Sitzungen und Bilder unterstützt
title: "CLI-Backends"
---

# CLI-Backends (Fallback-Runtime)

OpenClaw kann **lokale KI-CLIs** als **rein textbasierten Fallback** ausführen, wenn API-Anbieter
ausfallen, rate-limitiert sind oder sich vorübergehend fehlerhaft verhalten. Dies ist bewusst
konservativ gehalten:

- **Werkzeuge sind deaktiviert** (keine Tool-Aufrufe).
- **Text rein → Text raus** (zuverlässig).
- **Sitzungen werden unterstützt** (damit Folgeeingaben kohärent bleiben).
- **Bilder können durchgereicht werden**, wenn die CLI Bildpfade akzeptiert.

Dies ist als **Sicherheitsnetz** und nicht als primärer Pfad konzipiert. Verwenden Sie es, wenn Sie
„funktioniert immer“-Textantworten wünschen, ohne sich auf externe APIs zu verlassen.

## Einsteigerfreundlicher Schnellstart

Sie können Claude Code CLI **ohne jegliche Konfiguration** verwenden (OpenClaw liefert eine integrierte Standardkonfiguration):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI funktioniert ebenfalls sofort:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Wenn Ihr Gateway unter launchd/systemd läuft und PATH minimal ist, fügen Sie lediglich den
Befehlspfad hinzu:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

Das war’s. Keine Schlüssel, keine zusätzliche Authentifizierungskonfiguration über die CLI selbst hinaus erforderlich.

## Verwendung als Fallback

Fügen Sie einen CLI-Backend zu Ihrer Fallback-Liste hinzu, sodass er nur ausgeführt wird, wenn primäre Modelle fehlschlagen:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Hinweise:

- Wenn Sie `agents.defaults.models` (Allowlist) verwenden, müssen Sie `claude-cli/...` einschließen.
- Wenn der primäre Anbieter fehlschlägt (Auth, Rate-Limits, Timeouts), versucht OpenClaw
  als Nächstes den CLI-Backend.

## Konfigurationsübersicht

Alle CLI-Backends befinden sich unter:

```
agents.defaults.cliBackends
```

Jeder Eintrag ist durch eine **Provider-ID** gekennzeichnet (z. B. `claude-cli`, `my-cli`).
Die Provider-ID wird zur linken Seite Ihrer Modell-Referenz:

```
<provider>/<model>
```

### Beispielkonfiguration

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Wie es funktioniert

1. **Wählt ein Backend aus** basierend auf dem Provider-Präfix (`claude-cli/...`).
2. **Erstellt einen System-Prompt** unter Verwendung desselben OpenClaw-Prompts + Workspace-Kontext.
3. **Führt die CLI aus** mit einer Sitzungs-ID (falls unterstützt), sodass der Verlauf konsistent bleibt.
4. **Parst die Ausgabe** (JSON oder Klartext) und gibt den finalen Text zurück.
5. **Persistiert Sitzungs-IDs** pro Backend, sodass Folgeeingaben dieselbe CLI-Sitzung wiederverwenden.

## Sitzungen

- Wenn die CLI Sitzungen unterstützt, setzen Sie `sessionArg` (z. B. `--session-id`) oder
  `sessionArgs` (Platzhalter `{sessionId}`), wenn die ID in mehrere Flags eingefügt werden muss.
- Wenn die CLI einen **Resume-Subcommand** mit unterschiedlichen Flags verwendet, setzen Sie
  `resumeArgs` (ersetzt `args` beim Fortsetzen) und optional `resumeOutput`
  (für Nicht-JSON-Resumes).
- `sessionMode`:
  - `always`: immer eine Sitzungs-ID senden (neue UUID, falls keine gespeichert ist).
  - `existing`: nur eine Sitzungs-ID senden, wenn zuvor eine gespeichert war.
  - `none`: niemals eine Sitzungs-ID senden.

## Bilder (Durchreichen)

Wenn Ihre CLI Bildpfade akzeptiert, setzen Sie `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw schreibt Base64-Bilder in temporäre Dateien. Wenn `imageArg` gesetzt ist, werden diese
Pfade als CLI-Argumente übergeben. Wenn `imageArg` fehlt, hängt OpenClaw die
Dateipfade an den Prompt an (Path-Injection), was für CLIs ausreicht, die lokale Dateien aus
reinen Pfadangaben automatisch laden (Verhalten von Claude Code CLI).

## Eingaben / Ausgaben

- `output: "json"` (Standard) versucht, JSON zu parsen und Text + Sitzungs-ID zu extrahieren.
- `output: "jsonl"` parst JSONL-Streams (Codex CLI `--json`) und extrahiert die
  letzte Agent-Nachricht sowie `thread_id`, sofern vorhanden.
- `output: "text"` behandelt stdout als finale Antwort.

Eingabemodi:

- `input: "arg"` (Standard) übergibt den Prompt als letztes CLI-Argument.
- `input: "stdin"` sendet den Prompt über stdin.
- Wenn der Prompt sehr lang ist und `maxPromptArgChars` gesetzt ist, wird stdin verwendet.

## Standardwerte (integriert)

OpenClaw liefert einen Standard für `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw liefert außerdem einen Standard für `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Überschreiben Sie dies nur bei Bedarf (häufig: absoluter `command`-Pfad).

## Einschränkungen

- **Keine OpenClaw-Werkzeuge** (der CLI-Backend erhält niemals Tool-Aufrufe). Einige CLIs
  können dennoch ihre eigenen Agent-Werkzeuge ausführen.
- **Kein Streaming** (CLI-Ausgabe wird gesammelt und dann zurückgegeben).
- **Strukturierte Ausgaben** hängen vom JSON-Format der CLI ab.
- **Codex-CLI-Sitzungen** werden über Textausgabe fortgesetzt (kein JSONL), was weniger
  strukturiert ist als der initiale `--json`-Lauf. OpenClaw-Sitzungen funktionieren
  weiterhin normal.

## Fehlerbehebung

- **CLI nicht gefunden**: setzen Sie `command` auf einen vollständigen Pfad.
- **Falscher Modellname**: verwenden Sie `modelAliases`, um `provider/model` → CLI-Modell zuzuordnen.
- **Keine Sitzungs-Kontinuität**: stellen Sie sicher, dass `sessionArg` gesetzt ist und `sessionMode` nicht
  `none` ist (Codex CLI kann derzeit nicht mit JSON-Ausgabe fortsetzen).
- **Bilder werden ignoriert**: setzen Sie `imageArg` (und verifizieren Sie, dass die CLI Dateipfade unterstützt).
