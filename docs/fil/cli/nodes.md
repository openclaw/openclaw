---
summary: "Sanggunian ng CLI para sa `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Pinamamahalaan mo ang mga ipinares na node (mga camera, screen, canvas)
  - Kailangan mong aprubahan ang mga kahilingan o mag-invoke ng mga command ng node
title: "nodes"
---

# `openclaw nodes`

Pamahalaan ang mga ipinares na node (mga device) at mag-invoke ng mga kakayahan ng node.

Kaugnay:

- Pangkalahatang-ideya ng nodes: [Nodes](/nodes)
- Camera: [Camera nodes](/nodes/camera)
- Mga Larawan: [Image nodes](/nodes/images)

Karaniwang mga opsyon:

- `--url`, `--token`, `--timeout`, `--json`

## Karaniwang mga command

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

Ang `nodes list` ay nagpi-print ng mga pending/paired table. Kasama sa mga paired row ang pinakabagong edad ng koneksyon (Last Connect).
Gamitin ang `--connected` upang ipakita lamang ang mga kasalukuyang nakakonektang node. Gamitin ang `--last-connected <duration>` upang
salain ang mga node na kumonekta sa loob ng isang tagal (hal. `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Mga flag ng invoke:

- `--params <json>`: JSON object string (default `{}`).
- `--invoke-timeout <ms>`: timeout ng node invoke (default `15000`).
- `--idempotency-key <key>`: opsyonal na idempotency key.

### Mga default na istilong Exec

`nodes run` ginagaya ang exec behavior ng model (mga default + approvals):

- Binabasa ang `tools.exec.*` (kasama ang mga override ng `agents.list[].tools.exec.*`).
- Gumagamit ng mga approval ng exec (`exec.approval.request`) bago i-invoke ang `system.run`.
- Maaaring alisin ang `--node` kapag naka-set ang `tools.exec.node`.
- Nangangailangan ng node na nag-a-advertise ng `system.run` (macOS companion app o headless node host).

Mga flag:

- `--cwd <path>`: working directory.
- `--env <key=val>`: env override (maaaring ulitin).
- `--command-timeout <ms>`: timeout ng command.
- `--invoke-timeout <ms>`: timeout ng node invoke (default `30000`).
- `--needs-screen-recording`: kailangan ng pahintulot sa screen recording.
- `--raw <command>`: magpatakbo ng shell string (`/bin/sh -lc` o `cmd.exe /c`).
- `--agent <id>`: mga approval/allowlist na saklaw ng agent (default sa naka-configure na agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: mga override.
