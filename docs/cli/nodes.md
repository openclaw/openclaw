---
summary: "CLI reference for `clawdbot nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - You’re managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
---

# `clawdbot nodes`

Manage paired nodes (devices) and invoke node capabilities.

Related:
- Nodes overview: [Nodes](/nodes)
- Camera: [Camera nodes](/nodes/camera)
- Images: [Image nodes](/nodes/images)

## Common commands

```bash
clawdbot nodes list
clawdbot nodes list --connected
clawdbot nodes list --last-connected 24h
clawdbot nodes pending
clawdbot nodes approve <requestId>
clawdbot nodes status
clawdbot nodes status --connected
clawdbot nodes status --last-connected 24h
```

`nodes list` prints pending/paired tables. Paired rows include the most recent connect age (Last Connect).
Use `--connected` to only show currently-connected nodes. Use `--last-connected <duration>` to
filter to nodes that connected within a duration (e.g. `24h`, `7d`).

## Invoke / run

```bash
clawdbot nodes invoke --node <id|name|ip> --command <command> --params <json>
clawdbot nodes run --node <id|name|ip> <command...>
clawdbot nodes run --raw "git status"
clawdbot nodes run --agent main --node <id|name|ip> --raw "git status"
```

### Exec-style defaults

`nodes run` mirrors the model’s exec behavior (defaults + approvals):

- Reads `tools.exec.*` (plus `agents.list[].tools.exec.*` overrides).
- Uses exec approvals (`exec.approval.request`) before invoking `system.run`.
- `--node` can be omitted when `tools.exec.node` is set.

Flags:
- `--raw <command>`: run a shell string (`/bin/sh -lc` or `cmd.exe /c`).
- `--agent <id>`: agent-scoped approvals/allowlists (defaults to configured agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: overrides.
