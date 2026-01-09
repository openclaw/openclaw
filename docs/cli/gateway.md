---
summary: "Clawdbot Gateway CLI (`clawdbot gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (LAN + tailnet)
---

# Gateway CLI

The Gateway is Clawdbot’s WebSocket server (providers, nodes, sessions, hooks).

Subcommands in this page live under `clawdbot gateway …`.

Related docs:
- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Run the Gateway

Run a local Gateway process:

```bash
clawdbot gateway
```

Notes:
- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.clawdbot/clawdbot.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
- Binding beyond loopback without auth is blocked (safety guardrail).
- `SIGUSR1` triggers an in-process restart (useful without a supervisor).

### Options

- `--port <port>`: WebSocket port (default comes from config/env; usually `18789`).
- `--bind <loopback|lan|tailnet|auto>`: listener bind mode.
- `--auth <token|password>`: auth mode override.
- `--token <token>`: token override (also sets `CLAWDBOT_GATEWAY_TOKEN` for the process).
- `--password <password>`: password override (also sets `CLAWDBOT_GATEWAY_PASSWORD` for the process).
- `--tailscale <off|serve|funnel>`: expose the Gateway via Tailscale.
- `--tailscale-reset-on-exit`: reset Tailscale serve/funnel config on shutdown.
- `--force`: kill any existing listener on the selected port before starting.
- `--verbose`: verbose logs.
- `--claude-cli-logs`: only show claude-cli logs in the console (and enable its stdout/stderr).
- `--ws-log <auto|full|compact>`: websocket log style (default `auto`).
- `--compact`: alias for `--ws-log compact`.
- `--raw-stream`: log raw model stream events to jsonl.
- `--raw-stream-path <path>`: raw stream jsonl path.

## Query a running Gateway

All query commands use WebSocket RPC.

Shared options:
- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: timeout (default `10000`).
- `--expect-final`: wait for a “final” response (agent calls).

### `gateway health`

```bash
clawdbot gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

```bash
clawdbot gateway status --url ws://127.0.0.1:18789
```

### `gateway call <method>`

Low-level RPC helper.

```bash
clawdbot gateway call status
clawdbot gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Discover gateways (Bonjour)

`gateway discover` scans for Gateway bridge beacons (`_clawdbot-bridge._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): `clawdbot.internal.` (requires split DNS + DNS server; see [/gateway/bonjour](/gateway/bonjour))

Only gateways with the **bridge enabled** will advertise the discovery beacon.

### `gateway discover`

```bash
clawdbot gateway discover
```

Options:
- `--timeout <ms>`: per-command timeout (browse/resolve); default `2000`.
- `--json`: machine-readable output (also disables styling/spinner).

Examples:

```bash
clawdbot gateway discover --timeout 4000
clawdbot gateway discover --json | jq '.beacons[].wsUrl'
```

