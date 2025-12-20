---
name: clawdis-notify
description: Send system notifications to specific Clawdis nodes (macOS computers) via the Gateway and CLI. Use when you need to alert a person or confirm a remote action on a particular machine, or when an agent must push a notification to another computer.
---

# Clawdis Notify

## Overview

Send local notifications to a specific Clawdis node (currently macOS only) via the Gateway CLI.

## Quick start

1) Find a target node.
```bash
clawdis nodes status
clawdis nodes describe --node <idOrNameOrIp>
```

2) Send the notification.
```bash
clawdis nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

## Core command

`clawdis nodes notify --node <idOrNameOrIp> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>]`

Notes:
- Provide at least one of `--title` or `--body`.
- `--delivery` defaults to `system`.
- Only macOS nodes expose `system.notify` right now.
- Notification permission must be granted in the macOS app or the command fails.

## Multi‑computer usage

Pick a specific node by id/name/IP, or iterate across nodes:

```bash
for node in $(clawdis nodes status --json | jq -r '.nodes[].id'); do
  clawdis nodes notify --node "$node" --title "Heads up" --body "Maintenance in 5 minutes"
done
```

## Troubleshooting

- `nodes notify failed: ...` usually means the node is offline, not paired, or missing permission.
- If the Gateway is down or unreachable, notifications cannot be delivered.

## Low‑level fallback (rare)

If needed, use raw invoke:
```bash
clawdis nodes invoke \
  --node <idOrNameOrIp> \
  --command system.notify \
  --params '{"title":"Ping","body":"Hello","sound":"Glass","priority":"active","delivery":"system"}'
```
