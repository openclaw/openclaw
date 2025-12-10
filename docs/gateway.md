---
summary: "Runbook for the Gateway daemon, lifecycle, and operations"
read_when:
  - Running or debugging the gateway process
---
# Gateway (daemon) runbook

Last updated: 2025-12-09

## What it is
- The always-on process that owns the single Baileys/Telegram connection and the control/event plane.
- Replaces the legacy `gateway` command. CLI entry point: `clawdis gateway`.
- Runs until stopped; exits non-zero on fatal errors so the supervisor restarts it.

## How to run (local)
```bash
pnpm clawdis gateway --port 18789
# for full debug/trace logs in stdio:
pnpm clawdis gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
pnpm clawdis gateway --force
```
- Binds WebSocket control plane to `127.0.0.1:<port>` (default 18789).
- Logs to stdout; use launchd/systemd to keep it alive and rotate logs.
- Pass `--verbose` to mirror debug logging (handshakes, req/res, events) from the log file into stdio when troubleshooting.
- `--force` uses `lsof` to find listeners on the chosen port, sends SIGTERM, logs what it killed, then starts the gateway (fails fast if `lsof` is missing).
- Optional shared secret: pass `--token <value>` or set `CLAWDIS_GATEWAY_TOKEN` to require clients to send `hello.auth.token`.

## Remote access
- Tailscale/VPN preferred; otherwise SSH tunnel:
  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```
- Clients then connect to `ws://127.0.0.1:18789` through the tunnel.
- If a token is configured, clients must include it in `hello.auth.token` even over the tunnel.

## Protocol (operator view)
- Mandatory first frame from client: `hello {type:"hello", minProtocol, maxProtocol, client:{name,version,platform,mode,instanceId}, caps, auth?, locale?, userAgent? }`.
- Gateway replies `hello-ok {type:"hello-ok", protocol:<chosen>, server:{version,commit,host,connId}, features:{methods,events}, snapshot:{presence[], health, stateVersion, uptimeMs}, policy:{maxPayload,maxBufferedBytes,tickIntervalMs} }` or `hello-error`.
- After handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Structured presence entries: `{host, ip, version, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`.
- `agent` responses are two-stage: first `res` ack `{runId,status:"accepted"}`, then a final `res` `{runId,status:"ok"|"error",summary}` after the run finishes; streamed output arrives as `event:"agent"`.

## Methods (initial set)
- `health` — full health snapshot (same shape as `clawdis health --json`).
- `status` — short summary.
- `system-presence` — current presence list.
- `system-event` — post a presence/system note (structured).
- `send` — send a message via the active provider(s).
- `agent` — run an agent turn (streams events back on same connection).

## Events
- `agent` — streamed tool/output events from the agent run (seq-tagged).
- `presence` — presence updates (deltas with stateVersion) pushed to all connected clients.
- `tick` — periodic keepalive/no-op to confirm liveness.
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Clients should reconnect.

## WebChat integration
- WebChat serves static assets locally (default port 18788, configurable).
- The WebChat backend keeps a single WS connection to the Gateway for control/data; all sends and agent runs flow through that connection.
- Remote use goes through the same SSH/Tailscale tunnel; if a gateway token is configured, WebChat must include it during hello.
- macOS app also connects via this WS (one socket); it hydrates presence from the initial snapshot and listens for `presence` events to update the UI.

## Typing and validation
- Server validates every inbound frame with AJV against JSON Schema emitted from the protocol definitions.
- Clients (TS/Swift) consume generated types (TS directly; Swift via quicktype from the JSON Schema).
- Types live in `src/gateway/protocol/*.ts`; regenerate schemas/models with `pnpm protocol:gen` (writes `dist/protocol.schema.json` and `apps/macos/Sources/ClawdisProtocol/Protocol.swift`).

## Connection snapshot
- `hello-ok` includes a `snapshot` with `presence`, `health`, `stateVersion`, and `uptimeMs` plus `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` so clients can render immediately without extra requests.
- `health`/`system-presence` remain available for manual refresh, but are not required at connect time.

## Error codes (res.error shape)
- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
- Standard codes:
  - `NOT_LINKED` — WhatsApp not authenticated.
  - `AGENT_TIMEOUT` — agent did not respond within the configured deadline.
  - `INVALID_REQUEST` — schema/param validation failed.
  - `UNAVAILABLE` — Gateway is shutting down or a dependency is unavailable.

## Keepalive behavior
- `tick` events (or WS ping/pong) are emitted periodically so clients know the Gateway is alive even when no traffic occurs.
- Send/agent acknowledgements remain separate responses; do not overload ticks for sends.

## Replay / gaps
- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. WebChat and macOS clients now auto-refresh on gap.

## Supervision (macOS example)
- Use launchd to keep the daemon alive:
  - Program: path to `clawdis`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: file paths or `syslog`
- On failure, launchd restarts; fatal misconfig should keep exiting so the operator notices.

## Supervision (systemd example)
```
[Unit]
Description=Clawdis Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/clawdis gateway --port 18789
Restart=on-failure
RestartSec=5
User=clawdis
Environment=CLAWDIS_GATEWAY_TOKEN=
WorkingDirectory=/home/clawdis

[Install]
WantedBy=multi-user.target
```
Enable with `systemctl enable --now clawdis-gateway.service`.

## Operational checks
- Liveness: open WS and send `hello` → expect `hello-ok` (with snapshot).
- Readiness: call `health` → expect `ok: true` and `web.linked=true`.
- Debug: subscribe to `tick` and `presence` events; ensure `status` shows linked/auth age; presence entries show Gateway host and connected clients.

## Safety guarantees
- Only one Gateway per host; all sends/agent calls must go through it.
- No fallback to direct Baileys connections; if the Gateway is down, sends fail fast.
- Non-hello first frames or malformed JSON are rejected and the socket is closed.
- Graceful shutdown: emit `shutdown` event before closing; clients must handle close + reconnect.

## CLI helpers
- `clawdis gateway health|status` — request health/status over the Gateway WS.
- `clawdis gateway send --to <num> --message "hi" [--media-url ...]` — send via Gateway (idempotent).
- `clawdis gateway agent --message "hi" [--to ...]` — run an agent turn (waits for final by default).
- `clawdis gateway call <method> --params '{"k":"v"}'` — raw method invoker for debugging.
- Gateway helper subcommands assume a running gateway on `--url`; they no longer auto-spawn one.

## Migration guidance
- Retire uses of `clawdis gateway` and the legacy TCP control port.
- Update clients to speak the WS protocol with mandatory hello and structured presence.
