---
summary: "CLI-reference for `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Du administrerer parrede noder (kameraer, skærm, lærred)
  - Du skal godkende anmodninger eller kalde node-kommandoer
title: "nodes"
---

# `openclaw nodes`

Administrér parrede noder (enheder) og kald nodefunktioner.

Relateret:

- Overblik over noder: [Nodes](/nodes)
- Kamera: [Camera nodes](/nodes/camera)
- Billeder: [Image nodes](/nodes/images)

Fælles indstillinger:

- `--url`, `--token`, `--timeout`, `--json`

## Fælles kommandoer

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

`nodes list` tryk ventende/parrede tabeller. Parrede rækker inkluderer den seneste forbindelsesalder (seneste forbindelse).
Brug `-- connected` til kun at vise nutidigt forbundne noder. Brug `--last-tilsluttet <duration>` til
-filter til noder, der er tilsluttet inden for en varighed (f.eks. `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke-flag:

- `--params <json>`: JSON-objektstreng (standard `{}`).
- `--invoke-timeout <ms>`: timeout for node-invoke (standard `15000`).
- `--idempotency-key <key>`: valgfri idempotensnøgle.

### Exec-lignende standarder

`nodes run` afspejler modellens exec-adfærd (standarder + godkendelser):

- Læser `tools.exec.*` (plus `agents.list[].tools.exec.*`-overstyringer).
- Bruger exec-godkendelser (`exec.approval.request`) før kald af `system.run`.
- `--node` kan udelades, når `tools.exec.node` er sat.
- Kræver en node, der annoncerer `system.run` (macOS companion-app eller headless node host).

Flag:

- `--cwd <path>`: arbejdsmappe.
- `--env <key=val>`: env-overstyring (kan gentages).
- `--command-timeout <ms>`: timeout for kommando.
- `--invoke-timeout <ms>`: timeout for node-invoke (standard `30000`).
- `--needs-screen-recording`: kræv tilladelse til skærmoptagelse.
- `--raw <command>`: kør en shell-streng (`/bin/sh -lc` eller `cmd.exe /c`).
- `--agent <id>`: agent-afgrænsede godkendelser/tilladelseslister (standard er konfigureret agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: overstyringer.
