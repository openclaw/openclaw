---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw node` (headless node host)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running the headless node host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pairing a non-macOS node for system.run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a **headless node host** that connects to the Gateway WebSocket and exposes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`system.run` / `system.which` on this machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why use a node host?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a node host when you want agents to **run commands on other machines** in your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
network without installing a full macOS companion app there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common use cases:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run commands on remote Linux/Windows boxes (build servers, lab machines, NAS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep exec **sandboxed** on the gateway, but delegate approved runs to other hosts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provide a lightweight, headless execution target for automation or CI nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution is still guarded by **exec approvals** and per‑agent allowlists on the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node host, so you can keep command access scoped and explicit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser proxy (zero-config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Node hosts automatically advertise a browser proxy if `browser.enabled` is not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
disabled on the node. This lets the agent use browser automation on that node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without extra configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable it on the node if needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  nodeHost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    browserProxy: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run (foreground)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node run --host <gateway-host> --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--port <port>`: Gateway WebSocket port (default: `18789`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tls`: Use TLS for the gateway connection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--node-id <id>`: Override node id (clears pairing token)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--display-name <name>`: Override the node display name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Service (background)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install a headless node host as a user service.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node install --host <gateway-host> --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--port <port>`: Gateway WebSocket port (default: `18789`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tls`: Use TLS for the gateway connection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--node-id <id>`: Override node id (clears pairing token)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--display-name <name>`: Override the node display name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--runtime <runtime>`: Service runtime (`node` or `bun`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`: Reinstall/overwrite if already installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage the service:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `openclaw node run` for a foreground node host (no service).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Service commands accept `--json` for machine-readable output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The first connection creates a pending node pair request on the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approve it via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The node host stores its node id, token, display name, and gateway connection info in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/node.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`system.run` is gated by local exec approvals:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/exec-approvals.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw approvals --node <id|name|ip>` (edit from the Gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
