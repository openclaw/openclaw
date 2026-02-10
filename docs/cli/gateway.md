---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running the Gateway from the CLI (dev or servers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Gateway auth, bind modes, and connectivity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discovering gateways via Bonjour (LAN + tailnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway is OpenClaw’s WebSocket server (channels, nodes, sessions, hooks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands in this page live under `openclaw gateway …`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/bonjour](/gateway/bonjour)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/discovery](/gateway/discovery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a local Gateway process:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Foreground alias:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binding beyond loopback without auth is blocked (safety guardrail).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SIGUSR1` triggers an in-process restart when authorized (enable `commands.restart` or use the gateway tool/config apply/update).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SIGINT`/`SIGTERM` handlers stop the gateway process, but they don’t restore any custom terminal state. If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--port <port>`: WebSocket port (default comes from config/env; usually `18789`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--auth <token|password>`: auth mode override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: token override (also sets `OPENCLAW_GATEWAY_TOKEN` for the process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`: password override (also sets `OPENCLAW_GATEWAY_PASSWORD` for the process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale <off|serve|funnel>`: expose the Gateway via Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale-reset-on-exit`: reset Tailscale serve/funnel config on shutdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--allow-unconfigured`: allow gateway start without `gateway.mode=local` in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dev`: create a dev config + workspace if missing (skips BOOTSTRAP.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reset`: reset dev config + credentials + sessions + workspace (requires `--dev`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`: kill any existing listener on the selected port before starting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`: verbose logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--claude-cli-logs`: only show claude-cli logs in the console (and enable its stdout/stderr).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ws-log <auto|full|compact>`: websocket log style (default `auto`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--compact`: alias for `--ws-log compact`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--raw-stream`: log raw model stream events to jsonl.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--raw-stream-path <path>`: raw stream jsonl path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Query a running Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All query commands use WebSocket RPC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Output modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: human-readable (colored in TTY).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable JSON (no styling/spinner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-color` (or `NO_COLOR=1`): disable ANSI while keeping human layout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shared options (where supported):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <url>`: Gateway WebSocket URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: Gateway token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`: Gateway password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: timeout/budget (varies per command).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--expect-final`: wait for a “final” response (agent calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: when you set `--url`, the CLI does not fall back to config or environment credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway health`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway health --url ws://127.0.0.1:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway status` shows the Gateway service (launchd/systemd/schtasks) plus an optional RPC probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <url>`: override the probe URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: token auth for the probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`: password auth for the probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: probe timeout (default `10000`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-probe`: skip the RPC probe (service-only view).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deep`: scan system-level services too.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway probe` is the “debug everything” command. It always probes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- your configured remote gateway (if set), and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- localhost (loopback) **even if remote is configured**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway probe --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Remote over SSH (Mac app parity)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app “Remote over SSH” mode uses a local port-forward so the remote gateway (which may be bound to loopback only) becomes reachable at `ws://127.0.0.1:<port>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI equivalent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway probe --ssh user@gateway-host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ssh <target>`: `user@host` or `user@host:port` (port defaults to `22`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ssh-identity <path>`: identity file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ssh-auto`: pick the first discovered gateway host as SSH target (LAN/WAB only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config (optional, used as defaults):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.sshTarget`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.sshIdentity`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway call <method>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Low-level RPC helper.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manage the Gateway service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` supports `--port`, `--runtime`, `--token`, `--force`, `--json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lifecycle commands accept `--json` for scripting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discover gateways (Bonjour)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway discover` scans for Gateway beacons (`_openclaw-gw._tcp`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multicast DNS-SD: `local.`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unicast DNS-SD (Wide-Area Bonjour): choose a domain (example: `openclaw.internal.`) and set up split DNS + a DNS server; see [/gateway/bonjour](/gateway/bonjour)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only gateways with Bonjour discovery enabled (default) advertise the beacon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wide-Area discovery records include (TXT):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role` (gateway role hint)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `transport` (transport hint, e.g. `gateway`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayPort` (WebSocket port, usually `18789`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sshPort` (SSH port; defaults to `22` if not present)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailnetDns` (MagicDNS hostname, when available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayTls` / `gatewayTlsSha256` (TLS enabled + cert fingerprint)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cliPath` (optional hint for remote installs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway discover`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway discover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: per-command timeout (browse/resolve); default `2000`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable output (also disables styling/spinner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway discover --timeout 4000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway discover --json | jq '.beacons[].wsUrl'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
