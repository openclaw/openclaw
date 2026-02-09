---
summary: "„Bun-Workflow (experimentell): Installation und Fallstricke im Vergleich zu pnpm“"
read_when:
  - Sie möchten den schnellsten lokalen Entwicklungszyklus (bun + watch)
  - Sie stoßen auf Probleme bei Bun-Installation/Patching/Lifecycle-Skripten
title: "„Bun (Experimentell)“"
---

# Bun (experimentell)

Ziel: Dieses Repo mit **Bun** ausführen (optional, nicht empfohlen für WhatsApp/Telegram),
ohne von pnpm-Workflows abzuweichen.

⚠️ **Nicht empfohlen für die Gateway-Laufzeit** (WhatsApp/Telegram-Bugs). Verwenden Sie Node für die Produktion.

## Status

- Bun ist eine optionale lokale Laufzeit, um TypeScript direkt auszuführen (`bun run …`, `bun --watch …`).
- `pnpm` ist der Standard für Builds und bleibt vollständig unterstützt (und wird von einigen Docs-Tools verwendet).
- Bun kann `pnpm-lock.yaml` nicht verwenden und ignoriert es.

## Installation

Standard:

```sh
bun install
```

Hinweis: `bun.lock`/`bun.lockb` werden von git ignoriert, es gibt also so oder so keine Repo-Änderungen. Wenn Sie _keine Lockfile-Schreibvorgänge_ möchten:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun-Lifecycle-Skripte (standardmäßig blockiert)

Bun kann Abhängigkeits-Lifecycle-Skripte blockieren, sofern sie nicht explizit vertraut werden (`bun pm untrusted` / `bun pm trust`).
Für dieses Repo sind die häufig blockierten Skripte nicht erforderlich:

- `@whiskeysockets/baileys` `preinstall`: prüft Node-Major >= 20 (wir verwenden Node 22+).
- `protobufjs` `postinstall`: gibt Warnungen zu inkompatiblen Versionsschemata aus (keine Build-Artefakte).

Wenn Sie auf ein echtes Laufzeitproblem stoßen, das diese Skripte erfordert, vertrauen Sie ihnen explizit:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Vorsichtsmaßnahmen

- Einige Skripte sind weiterhin fest auf pnpm verdrahtet (z. B. `docs:build`, `ui:*`, `protocol:check`). Führen Sie diese vorerst über pnpm aus.
