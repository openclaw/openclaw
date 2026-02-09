---
summary: "CLI-referens för `openclaw nodes` (list/status/approve/invoke, kamera/canvas/skärm)"
read_when:
  - Du hanterar parade noder (kameror, skärm, canvas)
  - Du behöver godkänna förfrågningar eller anropa nodkommandon
title: "nodes"
---

# `openclaw nodes`

Hantera parade noder (enheter) och anropa nodfunktioner.

Relaterat:

- Nodöversikt: [Nodes](/nodes)
- Kamera: [Camera nodes](/nodes/camera)
- Bilder: [Image nodes](/nodes/images)

Vanliga alternativ:

- `--url`, `--token`, `--timeout`, `--json`

## Vanliga kommandon

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

`nodes list` skriver ut väntande/parade tabeller. Parkopplade rader inkluderar den senaste anslutningsåldern (Last Connect).
Använd `--connected` för att bara visa nuvarande-anslutna noder. Använd `--last-connected <duration>` till
filter till noder som ansluts inom en varaktighet (t.ex. `24h`, `7d`).

## Anropa / kör

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Anropsflaggor:

- `--params <json>`: JSON-objektsträng (standard `{}`).
- `--invoke-timeout <ms>`: timeout för nodanrop (standard `15000`).
- `--idempotency-key <key>`: valfri idempotensnyckel.

### Exec-stilens standardvärden

`nodes run` speglar modellens exec-beteende (standardvärden + godkännanden):

- Läser `tools.exec.*` (plus `agents.list[].tools.exec.*`-åsidosättningar).
- Använder exec-godkännanden (`exec.approval.request`) innan `system.run` anropas.
- `--node` kan utelämnas när `tools.exec.node` är inställt.
- Kräver en nod som annonserar `system.run` (macOS companion-app eller headless node host).

Flaggor:

- `--cwd <path>`: arbetskatalog.
- `--env <key=val>`: miljövariabelåsidosättning (kan upprepas).
- `--command-timeout <ms>`: timeout för kommando.
- `--invoke-timeout <ms>`: timeout för nodanrop (standard `30000`).
- `--needs-screen-recording`: kräv tillstånd för skärminspelning.
- `--raw <command>`: kör en shell-sträng (`/bin/sh -lc` eller `cmd.exe /c`).
- `--agent <id>`: agentomfångade godkännanden/tillåtelselistor (standard är konfigurerad agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: åsidosättningar.
