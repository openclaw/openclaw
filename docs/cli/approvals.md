---
summary: "CLI reference for `smart-agent-neo approvals` (exec approvals for gateway or node hosts)"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: "approvals"
---

# `smart-agent-neo approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Common commands

```bash
smart-agent-neo approvals get
smart-agent-neo approvals get --node <id|name|ip>
smart-agent-neo approvals get --gateway
```

## Replace approvals from a file

```bash
smart-agent-neo approvals set --file ./exec-approvals.json
smart-agent-neo approvals set --node <id|name|ip> --file ./exec-approvals.json
smart-agent-neo approvals set --gateway --file ./exec-approvals.json
```

## Allowlist helpers

```bash
smart-agent-neo approvals allowlist add "~/Projects/**/bin/rg"
smart-agent-neo approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
smart-agent-neo approvals allowlist add --agent "*" "/usr/bin/uname"

smart-agent-neo approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` uses the same resolver as `smart-agent-neo nodes` (id, name, ip, or id prefix).
- `--agent` defaults to `"*"`, which applies to all agents.
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).
- Approvals files are stored per host at `~/.smart-agent-neo/exec-approvals.json`.
