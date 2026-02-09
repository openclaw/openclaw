---
summary: "CLI-Referenz für `openclaw status` (Diagnose, Probes, Nutzungs-Snapshots)"
read_when:
  - Sie möchten eine schnelle Diagnose der Kanal-Gesundheit und der jüngsten Sitzungs-Empfänger
  - Sie möchten einen einfügbaren „all“-Status für das Debugging
title: "Status"
---

# `openclaw status`

Diagnose für Kanäle + Sitzungen.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Hinweise:

- `--deep` führt Live-Probes aus (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Die Ausgabe enthält pro Agent Sitzungs-Speicher, wenn mehrere Agenten konfiguriert sind.
- Der Überblick enthält den Installations-/Laufzeitstatus von Gateway + Node-Host-Dienst, sofern verfügbar.
- Der Überblick enthält Update-Kanal + git-SHA (für Source-Checkouts).
- Update-Informationen werden im Überblick angezeigt; wenn ein Update verfügbar ist, gibt der Status einen Hinweis aus, `openclaw update` auszuführen (siehe [Updating](/install/updating)).
