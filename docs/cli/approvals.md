---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw approvals` (exec approvals for gateway or node hosts)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to edit exec approvals from the CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to manage allowlists on gateway or node hosts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "approvals"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw approvals`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage exec approvals for the **local host**, **gateway host**, or a **node host**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: [Exec approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes: [Nodes](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --node <id|name|ip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Replace approvals from a file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals set --file ./exec-approvals.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals set --gateway --file ./exec-approvals.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Allowlist helpers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add "~/Projects/**/bin/rg"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist remove "~/Projects/**/bin/rg"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--node` uses the same resolver as `openclaw nodes` (id, name, ip, or id prefix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent` defaults to `"*"`, which applies to all agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approvals files are stored per host at `~/.openclaw/exec-approvals.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
