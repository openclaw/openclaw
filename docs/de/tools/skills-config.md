---
summary: "Schema und Beispiele für die Skills-Konfiguration"
read_when:
  - Hinzufügen oder Ändern der Skills-Konfiguration
  - Anpassen der gebündelten Allowlist oder des Installationsverhaltens
title: "Skills-Konfiguration"
---

# Skills-Konfiguration

Die gesamte skillsbezogene Konfiguration befindet sich unter `skills` in `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Felder

- `allowBundled`: optionale Allowlist nur für **gebündelte** Skills. Wenn gesetzt, sind nur
  gebündelte Skills in der Liste zulässig (verwaltete/Workspace-Skills sind nicht betroffen).
- `load.extraDirs`: zusätzliche Skill-Verzeichnisse, die gescannt werden (niedrigste Priorität).
- `load.watch`: überwacht Skill-Ordner und aktualisiert den Skills-Snapshot (Standard: true).
- `load.watchDebounceMs`: Entprellung für Skill-Watcher-Ereignisse in Millisekunden (Standard: 250).
- `install.preferBrew`: bevorzugt Brew-Installer, wenn verfügbar (Standard: true).
- `install.nodeManager`: Node-Installer-Präferenz (`npm` | `pnpm` | `yarn` | `bun`, Standard: npm).
  Dies betrifft nur **Skill-Installationen**; die Gateway-Laufzeit sollte weiterhin Node sein
  (Bun nicht empfohlen für WhatsApp/Telegram).
- `entries.<skillKey>`: skill-spezifische Überschreibungen.

Skill-spezifische Felder:

- `enabled`: setzen Sie `false`, um einen Skill zu deaktivieren, auch wenn er gebündelt/installiert ist.
- `env`: Umgebungsvariablen, die für den Agent-Lauf injiziert werden (nur wenn sie noch nicht gesetzt sind).
- `apiKey`: optionale Vereinfachung für Skills, die eine primäre Umgebungsvariable deklarieren.

## Hinweise

- Schlüssel unter `entries` werden standardmäßig dem Skill-Namen zugeordnet. Wenn ein Skill
  `metadata.openclaw.skillKey` definiert, verwenden Sie stattdessen diesen Schlüssel.
- Änderungen an Skills werden beim nächsten Agent-Zug übernommen, wenn der Watcher aktiviert ist.

### Sandboxed Skills + Umgebungsvariablen

Wenn eine Sitzung **sandboxed** ist, laufen Skill-Prozesse innerhalb von Docker. Die Sandbox
übernimmt **nicht** die `process.env` des Hosts.

Verwenden Sie eine der folgenden Optionen:

- `agents.defaults.sandbox.docker.env` (oder agent-spezifisch `agents.list[].sandbox.docker.env`)
- Backen Sie die Umgebungsvariablen in Ihr benutzerdefiniertes Sandbox-Image ein

Globale `env` und `skills.entries.<skill>.env/apiKey` gelten nur für **Host**-Ausführungen.
