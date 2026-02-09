---
summary: "CLI-referentie voor `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Je beheert gekoppelde nodes (camera's, scherm, canvas)
  - Je moet verzoeken goedkeuren of node-opdrachten uitvoeren
title: "nodes"
---

# `openclaw nodes`

Beheer gekoppelde nodes (apparaten) en voer node-capaciteiten uit.

Gerelateerd:

- Nodes-overzicht: [Nodes](/nodes)
- Camera: [Camera nodes](/nodes/camera)
- Afbeeldingen: [Image nodes](/nodes/images)

Veelgebruikte opties:

- `--url`, `--token`, `--timeout`, `--json`

## Veelgebruikte opdrachten

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

`nodes list` toont tabellen met in behandeling/gekoppelde items. Gekoppelde rijen bevatten de meest recente verbindingsleeftijd (Last Connect).
Gebruik `--connected` om alleen momenteel verbonden nodes te tonen. Gebruik `--last-connected <duration>` om
te filteren op nodes die binnen een bepaalde duur verbonden zijn (bijv. `24h`, `7d`).

## Invoke / uitvoeren

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke-flags:

- `--params <json>`: JSON-objectstring (standaard `{}`).
- `--invoke-timeout <ms>`: timeout voor node-invoke (standaard `15000`).
- `--idempotency-key <key>`: optionele idempotency-sleutel.

### Exec-achtige standaardwaarden

`nodes run` weerspiegelt het exec-gedrag van het model (standaardwaarden + goedkeuringen):

- Leest `tools.exec.*` (plus `agents.list[].tools.exec.*`-overschrijvingen).
- Gebruikt uitvoeringsgoedkeuringen (`exec.approval.request`) voordat `system.run` wordt aangeroepen.
- `--node` kan worden weggelaten wanneer `tools.exec.node` is ingesteld.
- Vereist een node die `system.run` adverteert (macOS Companion-app of headless node-host).

Flags:

- `--cwd <path>`: werkmap.
- `--env <key=val>`: env-overschrijving (herhaalbaar).
- `--command-timeout <ms>`: command-timeout.
- `--invoke-timeout <ms>`: timeout voor node-invoke (standaard `30000`).
- `--needs-screen-recording`: vereis toestemming voor schermopname.
- `--raw <command>`: voer een shell-string uit (`/bin/sh -lc` of `cmd.exe /c`).
- `--agent <id>`: agent-gebonden goedkeuringen/toegestane lijsten (standaard de geconfigureerde agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: overschrijvingen.
