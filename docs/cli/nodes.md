---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You’re managing paired nodes (cameras, screen, canvas)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to approve requests or invoke node commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "nodes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage paired nodes (devices) and invoke node capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes overview: [Nodes](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera: [Camera nodes](/nodes/camera)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Images: [Image nodes](/nodes/images)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes list --connected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes list --last-connected 24h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status --connected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status --last-connected 24h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`nodes list` prints pending/paired tables. Paired rows include the most recent connect age (Last Connect).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--connected` to only show currently-connected nodes. Use `--last-connected <duration>` to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
filter to nodes that connected within a duration (e.g. `24h`, `7d`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Invoke / run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes run --node <id|name|ip> <command...>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes run --raw "git status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Invoke flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--params <json>`: JSON object string (default `{}`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--invoke-timeout <ms>`: node invoke timeout (default `15000`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--idempotency-key <key>`: optional idempotency key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Exec-style defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`nodes run` mirrors the model’s exec behavior (defaults + approvals):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reads `tools.exec.*` (plus `agents.list[].tools.exec.*` overrides).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses exec approvals (`exec.approval.request`) before invoking `system.run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--node` can be omitted when `tools.exec.node` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires a node that advertises `system.run` (macOS companion app or headless node host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--cwd <path>`: working directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--env <key=val>`: env override (repeatable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--command-timeout <ms>`: command timeout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--invoke-timeout <ms>`: node invoke timeout (default `30000`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--needs-screen-recording`: require screen recording permission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--raw <command>`: run a shell string (`/bin/sh -lc` or `cmd.exe /c`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent <id>`: agent-scoped approvals/allowlists (defaults to configured agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
