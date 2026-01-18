---
summary: "CLI reference for `clawdbot node` (headless node host)"
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
---

# `clawdbot node`

Run a **headless node host** that connects to the Gateway bridge and exposes
`system.run` / `system.which` on this machine.

## Start (foreground)

```bash
clawdbot node start --host <gateway-host> --port 18790
```

Options:
- `--host <host>`: Gateway bridge host (default: `127.0.0.1`)
- `--port <port>`: Gateway bridge port (default: `18790`)
- `--tls`: Use TLS for the bridge connection
- `--tls-fingerprint <sha256>`: Pin the bridge certificate fingerprint
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name

## Daemon (background service)

Install a headless node host as a user service.

```bash
clawdbot node daemon install --host <gateway-host> --port 18790
```

Options:
- `--host <host>`: Gateway bridge host (default: `127.0.0.1`)
- `--port <port>`: Gateway bridge port (default: `18790`)
- `--tls`: Use TLS for the bridge connection
- `--tls-fingerprint <sha256>`: Pin the bridge certificate fingerprint
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name
- `--runtime <runtime>`: Service runtime (`node` or `bun`)
- `--force`: Reinstall/overwrite if already installed

Manage the service:

```bash
clawdbot node daemon status
clawdbot node daemon start
clawdbot node daemon stop
clawdbot node daemon restart
clawdbot node daemon uninstall
```

## Pairing

The first connection creates a pending node pair request on the Gateway.
Approve it via:

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

The node host stores its node id + token in `~/.clawdbot/node.json`.

## Exec approvals

`system.run` is gated by local exec approvals:

- `~/.clawdbot/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
