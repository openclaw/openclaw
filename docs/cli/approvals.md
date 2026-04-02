---
summary: "CLI reference for `openclaw approvals` (exec approvals for gateway or node hosts)"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: "approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Common commands

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

`openclaw approvals get` now shows the effective exec policy for local, gateway, and node targets:

- requested `tools.exec` policy
- host approvals-file policy
- effective result after precedence rules are applied

Precedence is intentional:

- the host approvals file is the enforceable source of truth
- requested `tools.exec` policy can narrow or broaden intent, but the effective result is still derived from the host rules
- `--node` combines the node host approvals file with gateway `tools.exec` policy, because both still apply at runtime
- if gateway config is unavailable, the CLI falls back to the node approvals snapshot and notes that the final runtime policy could not be computed

## Replace approvals from a file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## "Never prompt" / YOLO example

For a host that should never stop on exec approvals, set the host approvals defaults to `full` + `off`:

```bash
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

Node variant:

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

This changes the **host approvals file** only. To keep the requested OpenClaw policy aligned, also set:

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.security full
openclaw config set tools.exec.ask off
```

This matches the current host-default YOLO behavior. Tighten it if you want approvals.

## Allowlist helpers

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` uses the same resolver as `openclaw nodes` (id, name, ip, or id prefix).
- `--agent` defaults to `"*"`, which applies to all agents.
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).
- Approvals files are stored per host at `~/.openclaw/exec-approvals.json`.
