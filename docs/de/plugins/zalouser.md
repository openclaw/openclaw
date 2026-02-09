---
summary: "„Zalo-Personal-Plugin: QR-Login + Messaging über zca-cli (Plugin-Installation + Kanal-Konfiguration + CLI + Werkzeug)“"
read_when:
  - Sie möchten Zalo Personal (inoffiziell) in OpenClaw unterstützen
  - Sie konfigurieren oder entwickeln das zalouser-Plugin
title: "„Zalo-Personal-Plugin“"
---

# Zalo Personal (Plugin)

Zalo-Personal-Unterstützung für OpenClaw über ein Plugin, das `zca-cli` verwendet, um ein normales Zalo-Benutzerkonto zu automatisieren.

> **Warnung:** Inoffizielle Automatisierung kann zur Sperrung oder zum Bann des Kontos führen. Nutzung auf eigenes Risiko.

## Benennung

Die Kanal-ID ist `zalouser`, um explizit zu machen, dass hier ein **persönliches Zalo-Benutzerkonto** (inoffiziell) automatisiert wird. Wir halten `zalo` für eine mögliche zukünftige offizielle Zalo-API-Integration reserviert.

## Wo es ausgeführt wird

Dieses Plugin läuft **innerhalb des Gateway-Prozesses**.

Wenn Sie ein entferntes Gateway verwenden, installieren und konfigurieren Sie es auf der **Maschine, auf der das Gateway läuft**, und starten Sie das Gateway anschließend neu.

## Installation

### Option A: Installation über npm

```bash
openclaw plugins install @openclaw/zalouser
```

Starten Sie das Gateway anschließend neu.

### Option B: Installation aus einem lokalen Ordner (Dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Starten Sie das Gateway anschließend neu.

## Voraussetzung: zca-cli

Die Gateway-Maschine muss `zca` auf `PATH` installiert haben:

```bash
zca --version
```

## Konfiguration

Die Kanal-Konfiguration befindet sich unter `channels.zalouser` (nicht `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Agent-Werkzeug

Werkzeugname: `zalouser`

Aktionen: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
