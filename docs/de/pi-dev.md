---
title: "Pi-Entwicklungsworkflow"
---

# Pi-Entwicklungsworkflow

Dieser Leitfaden fasst einen sinnvollen Workflow für die Arbeit an der Pi-Integration in OpenClaw zusammen.

## Typprüfung und Linting

- Typprüfung und Build: `pnpm build`
- Lint: `pnpm lint`
- Formatprüfung: `pnpm format`
- Vollständiges Gate vor dem Pushen: `pnpm lint && pnpm build && pnpm test`

## Ausführen von Pi-Tests

Verwenden Sie das dedizierte Skript für das Pi-Integrationstest-Set:

```bash
scripts/pi/run-tests.sh
```

Um den Live-Test einzuschließen, der echtes Anbieter-Verhalten ausführt:

```bash
scripts/pi/run-tests.sh --live
```

Das Skript führt alle pi-bezogenen Unit-Tests über diese Globs aus:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manuelles Testen

Empfohlener Ablauf:

- Gateway im Dev-Modus ausführen:
  - `pnpm gateway:dev`
- Agent direkt auslösen:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Die TUI für interaktives Debugging verwenden:
  - `pnpm tui`

Für das Verhalten von Werkzeugaufrufen fordern Sie eine `read`- oder `exec`-Aktion an, damit Sie Tool-Streaming und Payload-Verarbeitung sehen können.

## Zurücksetzen auf einen sauberen Zustand

Der Zustand liegt unter dem OpenClaw-Zustandsverzeichnis. Standard ist `~/.openclaw`. Wenn `OPENCLAW_STATE_DIR` gesetzt ist, verwenden Sie stattdessen dieses Verzeichnis.

Um alles zurückzusetzen:

- `openclaw.json` für die Konfiguration
- `credentials/` für Auth-Profile und Tokens
- `agents/<agentId>/sessions/` für die Agent-Sitzungshistorie
- `agents/<agentId>/sessions.json` für den Sitzungsindex
- `sessions/` falls Legacy-Pfade existieren
- `workspace/` wenn Sie einen leeren Workspace möchten

Wenn Sie nur Sitzungen zurücksetzen möchten, löschen Sie `agents/<agentId>/sessions/` und `agents/<agentId>/sessions.json` für diesen Agent. Behalten Sie `credentials/`, wenn Sie sich nicht erneut authentifizieren möchten.

## Referenzen

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
