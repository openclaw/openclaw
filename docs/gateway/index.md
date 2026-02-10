---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Runbook for the Gateway service, lifecycle, and operations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running or debugging the gateway process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway Runbook"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway service runbook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2025-12-09（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The always-on process that owns the single Baileys/Telegram connection and the control/event plane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replaces the legacy `gateway` command. CLI entry point: `openclaw gateway`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs until stopped; exits non-zero on fatal errors so the supervisor restarts it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to run (local)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# for full debug/trace logs in stdio:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789 --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# if the port is busy, terminate listeners then start:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# dev loop (auto-reload on TS changes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config hot reload watches `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default mode: `gateway.reload.mode="hybrid"` (hot-apply safe changes, restart on critical).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Hot reload uses in-process restart via **SIGUSR1** when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Disable with `gateway.reload.mode="off"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binds WebSocket control plane to `127.0.0.1:<port>` (default 18789).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The same port also serves HTTP (control UI, hooks, A2UI). Single-port multiplex.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Starts a Canvas file server by default on `canvasHost.port` (default `18793`), serving `http://<gateway-host>:18793/__openclaw__/canvas/` from `~/.openclaw/workspace/canvas`. Disable with `canvasHost.enabled=false` or `OPENCLAW_SKIP_CANVAS_HOST=1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs to stdout; use launchd/systemd to keep it alive and rotate logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pass `--verbose` to mirror debug logging (handshakes, req/res, events) from the log file into stdio when troubleshooting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force` uses `lsof` to find listeners on the chosen port, sends SIGTERM, logs what it killed, then starts the gateway (fails fast if `lsof` is missing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you run under a supervisor (launchd/systemd/mac app child-process mode), a stop/restart typically sends **SIGTERM**; older builds may surface this as `pnpm` `ELIFECYCLE` exit code **143** (SIGTERM), which is a normal shutdown, not a crash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SIGUSR1** triggers an in-process restart when authorized (gateway tool/config apply/update, or enable `commands.restart` for manual restarts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway auth is required by default: set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password`. Clients must send `connect.params.auth.token/password` unless using Tailscale Serve identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The wizard now generates a token by default, even on loopback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Port precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale/VPN preferred; otherwise SSH tunnel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ssh -N -L 18789:127.0.0.1:18789 user@host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients then connect to `ws://127.0.0.1:18789` through the tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a token is configured, clients must include it in `connect.params.auth.token` even over the tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multiple gateways (same host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usually unnecessary: one Gateway can serve multiple messaging channels and agents. Use multiple Gateways only for redundancy or strict isolation (ex: rescue bot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported if you isolate state + config and use unique ports. Full guide: [Multiple gateways](/gateway/multiple-gateways).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Service names are profile-aware:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: `bot.molt.<profile>` (legacy `com.openclaw.*` may still exist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux: `openclaw-gateway-<profile>.service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: `OpenClaw Gateway (<profile>)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install metadata is embedded in the service config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_MARKER=openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_KIND=gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_VERSION=<version>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rescue-Bot Pattern: keep a second Gateway isolated with its own profile, state dir, workspace, and base port spacing. Full guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Dev profile (`--dev`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fast path: run a fully-isolated dev instance (config/state/workspace) without touching your primary setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev gateway --allow-unconfigured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# then target the dev instance:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults (can be overridden via env/flags/config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR=~/.openclaw-dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- browser control service port = `19003` (derived: `gateway.port+2`, loopback only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost.port=19005` (derived: `gateway.port+4`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace` default becomes `~/.openclaw/workspace-dev` when you run `setup`/`onboard` under `--dev`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Derived ports (rules of thumb):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- browser control service port = base + 2 (loopback only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost.port = base + 4` (or `OPENCLAW_CANVAS_HOST_PORT` / config override)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108` (persisted per profile).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Checklist per instance:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- unique `gateway.port`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- unique `OPENCLAW_CONFIG_PATH`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- unique `OPENCLAW_STATE_DIR`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- unique `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- separate WhatsApp numbers (if using WA)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Service install per profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Protocol (operator view)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full docs: [Gateway protocol](/gateway/protocol) and [Bridge protocol (legacy)](/gateway/bridge-protocol).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mandatory first frame from client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway replies `res {type:"res", id, ok:true, payload:hello-ok }` (or `ok:false` with an error, then closes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After handshake:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Structured presence entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (for WS clients, `instanceId` comes from `connect.client.instanceId`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` responses are two-stage: first `res` ack `{runId,status:"accepted"}`, then a final `res` `{runId,status:"ok"|"error",summary}` after the run finishes; streamed output arrives as `event:"agent"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Methods (initial set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `health` — full health snapshot (same shape as `openclaw health --json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status` — short summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system-presence` — current presence list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system-event` — post a presence/system note (structured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send` — send a message via the active channel(s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` — run an agent turn (streams events back on same connection).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.list` — list paired + currently-connected nodes (includes `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, and advertised `commands`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.describe` — describe a node (capabilities + supported `node.invoke` commands; works for paired nodes and for currently-connected unpaired nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.invoke` — invoke a command on a node (e.g. `canvas.*`, `camera.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.*` — pairing lifecycle (`request`, `list`, `approve`, `reject`, `verify`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See also: [Presence](/concepts/presence) for how presence is produced/deduped and why a stable `client.instanceId` matters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` — streamed tool/output events from the agent run (seq-tagged).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `presence` — presence updates (deltas with stateVersion) pushed to all connected clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tick` — periodic keepalive/no-op to confirm liveness.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Clients should reconnect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WebChat integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebChat is a native SwiftUI UI that talks directly to the Gateway WebSocket for history, sends, abort, and events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote use goes through the same SSH/Tailscale tunnel; if a gateway token is configured, the client includes it during `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app connects via a single WS (shared connection); it hydrates presence from the initial snapshot and listens for `presence` events to update the UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Typing and validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Server validates every inbound frame with AJV against JSON Schema emitted from the protocol definitions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients (TS/Swift) consume generated types (TS directly; Swift via the repo’s generator).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Protocol definitions are the source of truth; regenerate schema/models with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen:swift`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connection snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hello-ok` includes a `snapshot` with `presence`, `health`, `stateVersion`, and `uptimeMs` plus `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` so clients can render immediately without extra requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `health`/`system-presence` remain available for manual refresh, but are not required at connect time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error codes (res.error shape)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Standard codes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NOT_LINKED` — WhatsApp not authenticated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `AGENT_TIMEOUT` — agent did not respond within the configured deadline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `INVALID_REQUEST` — schema/param validation failed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `UNAVAILABLE` — Gateway is shutting down or a dependency is unavailable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Keepalive behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tick` events (or WS ping/pong) are emitted periodically so clients know the Gateway is alive even when no traffic occurs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send/agent acknowledgements remain separate responses; do not overload ticks for sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Replay / gaps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. WebChat and macOS clients now auto-refresh on gap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supervision (macOS example)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use launchd to keep the service alive:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Program: path to `openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Arguments: `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - KeepAlive: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - StandardOut/Err: file paths or `syslog`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On failure, launchd restarts; fatal misconfig should keep exiting so the operator notices.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- LaunchAgents are per-user and require a logged-in session; for headless setups use a custom LaunchDaemon (not shipped).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw gateway install` writes `~/Library/LaunchAgents/bot.molt.gateway.plist`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    (or `bot.molt.<profile>.plist`; legacy `com.openclaw.*` is cleaned up).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw doctor` audits the LaunchAgent config and can update it to current defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway service management (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the Gateway CLI for install/start/stop/restart/status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` probes the Gateway RPC by default using the service’s resolved port/config (override with `--url`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --deep` adds system-level scans (LaunchDaemons/system units).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --no-probe` skips the RPC probe (useful when networking is down).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --json` is stable for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` reports **supervisor runtime** (launchd/systemd running) separately from **RPC reachability** (WS connect + status RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` prints config path + probe target to avoid “localhost vs LAN bind” confusion and profile mismatches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` includes the last gateway error line when the service looks running but the port is closed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logs` tails the Gateway file log via RPC (no manual `tail`/`grep` needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If other gateway-like services are detected, the CLI warns unless they are OpenClaw profile services.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  We still recommend **one gateway per machine** for most setups; use isolated profiles/ports for redundancy or a rescue bot. See [Multiple gateways](/gateway/multiple-gateways).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cleanup: `openclaw gateway uninstall` (current service) and `openclaw doctor` (legacy migrations).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` is a no-op when already installed; use `openclaw gateway install --force` to reinstall (profile/env/path changes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bundled mac app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw.app can bundle a Node-based gateway relay and install a per-user LaunchAgent labeled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.openclaw.*` labels still unload cleanly).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To stop it cleanly, use `openclaw gateway stop` (or `launchctl bootout gui/$UID/bot.molt.gateway`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To restart, use `openclaw gateway restart` (or `launchctl kickstart -k gui/$UID/bot.molt.gateway`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `launchctl` only works if the LaunchAgent is installed; otherwise use `openclaw gateway install` first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Replace the label with `bot.molt.<profile>` when running a named profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supervision (systemd user unit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw installs a **systemd user service** by default on Linux/WSL2. We（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
recommend user services for single-user machines (simpler env, per-user config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a **system service** for multi-user or always-on servers (no lingering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
required, shared supervision).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw gateway install` writes the user unit. `openclaw doctor` audits the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unit and can update it to match the current recommended defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Unit]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Description=OpenClaw Gateway (profile: <profile>, v<version>)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wants=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Service]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ExecStart=/usr/local/bin/openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart=always（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RestartSec=5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Environment=OPENCLAW_GATEWAY_TOKEN=（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WorkingDirectory=/home/youruser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Install]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WantedBy=default.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable lingering (required so the user service survives logout/idle):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo loginctl enable-linger youruser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Onboarding runs this on Linux/WSL2 (may prompt for sudo; writes `/var/lib/systemd/linger`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then enable the service:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user enable --now openclaw-gateway[-<profile>].service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Alternative (system service)** - for always-on or multi-user servers, you can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
install a systemd **system** unit instead of a user unit (no lingering needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `/etc/systemd/system/openclaw-gateway[-<profile>].service` (copy the unit above,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
switch `WantedBy=multi-user.target`, set `User=` + `WorkingDirectory=`), then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl daemon-reload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl enable --now openclaw-gateway[-<profile>].service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Windows (WSL2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Windows installs should use **WSL2** and follow the Linux systemd section above.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operational checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Liveness: open WS and send `req:connect` → expect `res` with `payload.type="hello-ok"` (with snapshot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Readiness: call `health` → expect `ok: true` and a linked channel in `linkChannel` (when applicable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debug: subscribe to `tick` and `presence` events; ensure `status` shows linked/auth age; presence entries show Gateway host and connected clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety guarantees（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Assume one Gateway per host by default; if you run multiple profiles, isolate ports/state and target the right instance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No fallback to direct Baileys connections; if the Gateway is down, sends fail fast.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-connect first frames or malformed JSON are rejected and the socket is closed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Graceful shutdown: emit `shutdown` event before closing; clients must handle close + reconnect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI helpers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway health|status` — request health/status over the Gateway WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw message send --target <num> --message "hi" [--media ...]` — send via Gateway (idempotent for WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw agent --message "hi" --to <num>` — run an agent turn (waits for final by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway call <method> --params '{"k":"v"}'` — raw method invoker for debugging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway stop|restart` — stop/restart the supervised gateway service (launchd/systemd).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway helper subcommands assume a running gateway on `--url`; they no longer auto-spawn one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retire uses of `openclaw gateway` and the legacy TCP control port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update clients to speak the WS protocol with mandatory connect and structured presence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
