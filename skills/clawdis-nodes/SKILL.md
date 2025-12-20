---
name: clawdis-nodes
description: Discover, interpret, and target Clawdis nodes (paired devices) via the Gateway/CLI. Use when an agent must find available nodes, choose the best target machine, or reason about presence vs node availability (Tailnet/Tailscale optional).
---

# Clawdis Nodes

Use the node system to target specific devices (macOS node mode, iOS, Android) for canvas/camera/screen/system actions. Use presence to infer which **user machine** is active, then pick the matching node.

## Quick start

List known nodes and whether they are paired/connected:
```bash
clawdis nodes status
```

Inspect a specific node (commands, caps, permissions):
```bash
clawdis nodes describe --node <idOrNameOrIp>
```

## Node discovery workflow (agent)

1) **List nodes** with `clawdis nodes status`.
2) **Choose a target**:
   - Prefer `connected` nodes with the capabilities you need.
   - Use `perms` (permissions map) to avoid asking for actions that will fail.
3) **Confirm commands** with `clawdis nodes describe --node …`.
4) **Invoke actions** via `clawdis nodes …` (camera, canvas, screen, system).

If no nodes are connected:
- Check pairing: `clawdis nodes pending` / `clawdis nodes list`
- Ask the user to open/foreground the node app if the action requires it (canvas/camera/screen on iOS/Android).

## Presence vs nodes (don’t confuse them)

**Presence** shows Gateway + connected clients (mac app, WebChat, CLI).  
**Nodes** are paired devices that expose commands.

Use presence to infer **where the user is active**, then map that to a node:

```bash
clawdis gateway call system-presence
```

Heuristics:
- Pick the presence entry with the smallest `lastInputSeconds` (most active).
- Match presence `host` / `deviceFamily` to a node `displayName` / `deviceFamily`.
- If multiple matches, ask for clarification or use `nodes describe` to choose.

Note: CLI connections (`client.mode=cli`) do **not** show up in presence.

## Tailnet / Tailscale (optional context)

Node discovery is Gateway‑owned; Tailnet details only matter for reaching the Gateway:
- On LAN, the Gateway advertises a Bridge via Bonjour.
- Cross‑network, prefer Tailnet MagicDNS or Tailnet IP to reach the Gateway.
- Once connected, always target nodes by id/name/IP via the Gateway (not direct).

## Pairing & approvals

List pairing requests:
```bash
clawdis nodes pending
```

Approve/reject:
```bash
clawdis nodes approve <requestId>
clawdis nodes reject <requestId>
```

## Typical agent usages

Send a notification to a specific Mac node:
```bash
clawdis nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Capture a node canvas snapshot:
```bash
clawdis nodes canvas snapshot --node <idOrNameOrIp> --format png
```

## Troubleshooting

- `NODE_BACKGROUND_UNAVAILABLE`: the node app must be foregrounded (iOS/Android).
- Missing permissions in `nodes status`: ask the user to grant permissions in the node app.
- No connected nodes: ensure the Gateway is reachable; check tailnet/SSH config if remote.
