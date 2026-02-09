---
summary: "„CLI-Referenz für `openclaw update` (weitgehend sichere Quellaktualisierung + automatischer Gateway-Neustart)“"
read_when:
  - Sie möchten einen Source-Checkout sicher aktualisieren
  - Sie müssen das Kurzschreibverhalten von `--update` verstehen
title: "„update“"
---

# `openclaw update`

Aktualisieren Sie OpenClaw sicher und wechseln Sie zwischen den Kanälen stable/beta/dev.

Wenn Sie über **npm/pnpm** installiert haben (globale Installation, keine Git-Metadaten), erfolgen Updates über den Paketmanager-Flow in [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: Überspringt den Neustart des Gateway-Dienstes nach einer erfolgreichen Aktualisierung.
- `--channel <stable|beta|dev>`: Legt den Update-Kanal fest (git + npm; in der Konfiguration persistiert).
- `--tag <dist-tag|version>`: Überschreibt den npm dist-tag oder die Version nur für dieses Update.
- `--json`: Gibt maschinenlesbares `UpdateRunResult`-JSON aus.
- `--timeout <seconds>`: Timeout pro Schritt (Standard ist 1200s).

Hinweis: Downgrades erfordern eine Bestätigung, da ältere Versionen die Konfiguration beschädigen können.

## `update status`

Zeigt den aktiven Update-Kanal sowie Git-Tag/Branch/SHA (für Source-Checkouts) und die Update-Verfügbarkeit an.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: Gibt maschinenlesbares Status-JSON aus.
- `--timeout <seconds>`: Timeout für Prüfungen (Standard ist 3s).

## `update wizard`

Interaktiver Ablauf zur Auswahl eines Update-Kanals und zur Bestätigung, ob der Gateway
nach der Aktualisierung neu gestartet werden soll (Standard ist Neustart). Wenn Sie `dev` ohne Git-Checkout auswählen, wird angeboten, einen zu erstellen.

## What it does

Wenn Sie explizit den Kanal wechseln (`--channel ...`), hält OpenClaw auch die
Installationsmethode synchron:

- `dev` → stellt einen Git-Checkout sicher (Standard: `~/openclaw`, Überschreiben mit `OPENCLAW_GIT_DIR`),
  aktualisiert ihn und installiert die globale CLI aus diesem Checkout.
- `stable`/`beta` → installiert aus npm unter Verwendung des passenden dist-tags.

## Git checkout flow

Channels:

- `stable`: Checkt den neuesten Non-Beta-Tag aus und führt anschließend Build + Doctor aus.
- `beta`: Checkt den neuesten `-beta`-Tag aus und führt anschließend Build + Doctor aus.
- `dev`: Checkt `main` aus und führt anschließend Fetch + Rebase aus.

High-level:

1. Erfordert einen sauberen Worktree (keine nicht committeten Änderungen).
2. Wechselt zum ausgewählten Kanal (Tag oder Branch).
3. Ruft Upstream ab (nur dev).
4. Nur dev: Preflight-Lint + TypeScript-Build in einem temporären Worktree; wenn der Tip fehlschlägt, wird bis zu 10 Commits zurückgegangen, um den neuesten sauberen Build zu finden.
5. Rebase auf den ausgewählten Commit (nur dev).
6. Installiert Abhängigkeiten (pnpm bevorzugt; npm als Fallback).
7. Baut und baut die Control UI.
8. Führt `openclaw doctor` als finalen „sicheren Update“-Check aus.
9. Synchronisiert Plugins mit dem aktiven Kanal (dev verwendet gebündelte Erweiterungen; stable/beta verwendet npm) und aktualisiert npm-installierte Plugins.

## `--update` shorthand

`openclaw --update` wird zu `openclaw update` umgeschrieben (nützlich für Shells und Launcher-Skripte).

## See also

- `openclaw doctor` (bietet an, bei Git-Checkouts zuerst ein Update auszuführen)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
