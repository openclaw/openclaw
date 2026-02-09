---
summary: "Debugging-Werkzeuge: Watch-Modus, rohe Modell-Streams und Nachverfolgung von Reasoning-Leakage"
read_when:
  - Sie müssen rohe Modellausgaben auf Reasoning-Leakage prüfen
  - Sie möchten den Gateway im Watch-Modus während der Iteration ausführen
  - Sie benötigen einen wiederholbaren Debugging-Workflow
title: "Debugging"
---

# Debugging

Diese Seite behandelt Debugging-Hilfen für Streaming-Ausgaben, insbesondere wenn
ein Anbieter Reasoning in normalen Text mischt.

## Laufzeit-Debug-Overrides

Verwenden Sie `/debug` im Chat, um **nur zur Laufzeit** Konfigurations-Overrides zu setzen (Speicher, nicht Festplatte).
`/debug` ist standardmäßig deaktiviert; aktivieren Sie es mit `commands.debug: true`.
Das ist praktisch, wenn Sie seltene Einstellungen umschalten müssen, ohne `openclaw.json` zu bearbeiten.

Beispiele:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` löscht alle Overrides und kehrt zur Konfiguration auf der Festplatte zurück.

## Gateway Watch-Modus

Für schnelle Iterationen führen Sie den Gateway unter dem Dateiwächter aus:

```bash
pnpm gateway:watch --force
```

Diese Karten zu:

```bash
tsx watch src/entry.ts gateway --force
```

Fügen Sie beliebige Gateway-CLI-Flags nach `gateway:watch` hinzu; sie werden bei
jedem Neustart durchgereicht.

## Dev-Profil + Dev-Gateway (--dev)

Verwenden Sie das Dev-Profil, um Zustand zu isolieren und ein sicheres, wegwerfbares Setup
für das Debugging zu starten. Es gibt **zwei** `--dev`-Flags:

- **Globales `--dev` (Profil):** isoliert den Zustand unter `~/.openclaw-dev` und
  setzt den Gateway-Port standardmäßig auf `19001` (abgeleitete Ports verschieben sich entsprechend).
- **`gateway --dev`: weist den Gateway an, automatisch eine Standardkonfiguration +
  einen Workspace zu erstellen**, falls diese fehlen (und BOOTSTRAP.md zu überspringen).

Empfohlener Ablauf (Dev-Profil + Dev-Bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Wenn Sie noch keine globale Installation haben, führen Sie die CLI über `pnpm openclaw ...` aus.

Was das bewirkt:

1. **Profil-Isolation** (globales `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (Browser/Canvas verschieben sich entsprechend)

2. **Dev-Bootstrap** (`gateway --dev`)
   - Schreibt eine minimale Konfiguration, falls sie fehlt (`gateway.mode=local`, bind loopback).
   - Setzt `agent.workspace` auf den Dev-Workspace.
   - Setzt `agent.skipBootstrap=true` (kein BOOTSTRAP.md).
   - Befüllt die Workspace-Dateien, falls sie fehlen:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Standardidentität: **C3‑PO** (Protokoll-Droide).
   - Überspringt Kanal-Anbieter im Dev-Modus (`OPENCLAW_SKIP_CHANNELS=1`).

Reset-Ablauf (Neustart von Grund auf):

```bash
pnpm gateway:dev:reset
```

Hinweis: `--dev` ist ein **globales** Profil-Flag und wird von einigen Runnern geschluckt.
Wenn Sie es explizit angeben müssen, verwenden Sie die Env-Variante:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` löscht Konfiguration, Anmeldedaten, Sitzungen und den Dev-Workspace (unter Verwendung von
`trash`, nicht `rm`), und erstellt anschließend das Standard-Dev-Setup neu.

Tipp: Wenn bereits ein Nicht-Dev-Gateway läuft (launchd/systemd), stoppen Sie ihn zuerst:

```bash
openclaw gateway stop
```

## Rohes Stream-Logging (OpenClaw)

OpenClaw kann den **rohen Assistant-Stream** vor jeglicher Filterung/Formatierung protokollieren.
Dies ist der beste Weg, um zu sehen, ob Reasoning als reine Text-Deltas ankommt
(oder als separate Thinking-Blöcke).

Aktivieren Sie es per CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Optionale Pfadüberschreibung:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Äquivalente env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Standarddatei:

`~/.openclaw/logs/raw-stream.jsonl`

## Rohes Chunk-Logging (pi-mono)

Um **rohe OpenAI-kompatible Chunks** zu erfassen, bevor sie in Blöcke geparst werden,
stellt pi-mono einen separaten Logger bereit:

```bash
PI_RAW_STREAM=1
```

Optionaler Pfad:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Standarddatei:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Hinweis: Dies wird nur von Prozessen ausgegeben, die den
> `openai-completions`-Anbieter von pi-mono verwenden.

## Sicherheitshinweise

- Rohe Stream-Logs können vollständige Prompts, Werkzeugausgaben und Benutzerdaten enthalten.
- Bewahren Sie Logs lokal auf und löschen Sie sie nach dem Debugging.
- Wenn Sie Logs teilen, entfernen Sie zuvor Geheimnisse und personenbezogene Daten (PII).
