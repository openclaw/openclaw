---
summary: "CLI reference for `openclaw node` (headless node host)"
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
title: "node"
---

# `openclaw node`

Run a **headless node host** that connects to the Gateway WebSocket and exposes
`system.run` / `system.which` on this machine.

## Why use a node host?

Use a node host when you want agents to **run commands on other machines** in your
network without installing a full macOS companion app there.

Common use cases:

- Run commands on remote Linux/Windows boxes (build servers, lab machines, NAS).
- Keep exec **sandboxed** on the gateway, but delegate approved runs to other hosts.
- Provide a lightweight, headless execution target for automation or CI nodes.

Execution is still guarded by **exec approvals** and per‑agent allowlists on the
node host, so you can keep command access scoped and explicit.

## Browser proxy (zero-config)

Node hosts automatically advertise a browser proxy if `browser.enabled` is not
disabled on the node. This lets the agent use browser automation on that node
without extra configuration.

Disable it on the node if needed:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Run (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--tls`: Use TLS for the gateway connection
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--header <header>`: HTTP header for WebSocket upgrade (`Name: value`); repeatable
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name

## Reverse proxy auth (e.g. Cloudflare Zero Trust)

When the gateway is behind Cloudflare Zero Trust or another proxy that requires custom headers on the WebSocket upgrade, use repeatable `--header`:

```bash
openclaw node run --host gateway.example.com --port 443 --tls \
  --header "CF-Access-Client-Id: your-client-id" \
  --header "CF-Access-Client-Secret: your-client-secret"
```

For an installed service, you can pass the same `--header` flags to `openclaw node install`, or set environment variables so secrets are not stored in config or command lines:

- `OPENCLAW_NODE_HEADERS`: JSON object of header name to value, e.g. `{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}`
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`: Automatically added as `CF-Access-Client-Id` and `CF-Access-Client-Secret` on the WebSocket request

Configure these in the service environment (launchd `EnvironmentVariables`, systemd `Environment=`, or Task Scheduler env) so the node host sends the headers when it connects.

## Gateway auth for node host

`openclaw node run` and `openclaw node install` resolve gateway auth from config/env (no `--token`/`--password` flags on node commands):

- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` are checked first.
- Then local config fallback: `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally does not inherit `gateway.remote.token` / `gateway.remote.password`.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, node auth resolution fails closed (no remote fallback masking).
- In `gateway.mode=remote`, remote client fields (`gateway.remote.token` / `gateway.remote.password`) are also eligible per remote precedence rules.
- Legacy `CLAWDBOT_GATEWAY_*` env vars are ignored for node host auth resolution.

## Service (background)

Install a headless node host as a user service.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--tls`: Use TLS for the gateway connection
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--header <header>`: HTTP header for WebSocket upgrade (`Name: value`); repeatable
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name
- `--runtime <runtime>`: Service runtime (`node` or `bun`)
- `--force`: Reinstall/overwrite if already installed

Manage the service:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Use `openclaw node run` for a foreground node host (no service).

Service commands accept `--json` for machine-readable output.

## Pairing

The first connection creates a pending device pairing request (`role: node`) on the Gateway.
Approve it via:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

The node host stores its node id, token, display name, and gateway connection info in
`~/.openclaw/node.json`.

## Exec approvals

`system.run` is gated by local exec approvals:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (edit from the Gateway)
