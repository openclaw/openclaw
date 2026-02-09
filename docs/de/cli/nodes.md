---
summary: "CLI-Referenz für `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Sie verwalten gekoppelte Nodes (Kameras, Bildschirm, Canvas)
  - Sie müssen Anfragen genehmigen oder Node-Befehle ausführen
title: "Nodes"
---

# `openclaw nodes`

Verwalten Sie gekoppelte Nodes (Geräte) und führen Sie Node-Funktionen aus.

Verwandt:

- Nodes-Überblick: [Nodes](/nodes)
- Kamera: [Camera nodes](/nodes/camera)
- Bilder: [Image nodes](/nodes/images)

Häufige Optionen:

- `--url`, `--token`, `--timeout`, `--json`

## Häufige Befehle

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` gibt Tabellen für ausstehende/gekoppelte Nodes aus. Gekoppelte Zeilen enthalten das Alter der letzten Verbindung (Last Connect).
Verwenden Sie `--connected`, um nur aktuell verbundene Nodes anzuzeigen. Verwenden Sie `--last-connected <duration>`, um
auf Nodes zu filtern, die sich innerhalb einer Dauer verbunden haben (z. B. `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke-Flags:

- `--params <json>`: JSON-Objekt-String (Standard `{}`).
- `--invoke-timeout <ms>`: Node-Invoke-Timeout (Standard `15000`).
- `--idempotency-key <key>`: optionaler Idempotenzschlüssel.

### Exec-ähnliche Standardwerte

`nodes run` spiegelt das Exec-Verhalten des Modells wider (Standards + Genehmigungen):

- Liest `tools.exec.*` (plus `agents.list[].tools.exec.*`-Überschreibungen).
- Verwendet Exec-Genehmigungen (`exec.approval.request`) vor dem Aufruf von `system.run`.
- `--node` kann weggelassen werden, wenn `tools.exec.node` gesetzt ist.
- Erfordert einen Node, der `system.run` bewirbt (macOS-Companion-App oder headless Node-Host).

Flags:

- `--cwd <path>`: Arbeitsverzeichnis.
- `--env <key=val>`: Env-Override (wiederholbar).
- `--command-timeout <ms>`: Befehls-Timeout.
- `--invoke-timeout <ms>`: Node-Invoke-Timeout (Standard `30000`).
- `--needs-screen-recording`: Bildschirmaufnahmeberechtigung erforderlich.
- `--raw <command>`: eine Shell-Zeichenkette ausführen (`/bin/sh -lc` oder `cmd.exe /c`).
- `--agent <id>`: agentenbezogene Genehmigungen/Allowlists (Standard: konfigurierter Agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: Überschreibungen.
