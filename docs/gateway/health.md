---
summary: "Health check commands and gateway health monitoring"
read_when:
  - Diagnosing channel connectivity or gateway health
  - Understanding health check CLI commands and options
title: "Health checks"
---

Short guide to verify channel connectivity without guessing.

## Quick checks

- `openclaw status` — local summary: gateway reachability/mode, update hint, linked channel auth age, sessions + recent activity.
- `openclaw status --all` — full local diagnosis (read-only, color, safe to paste for debugging).
- `openclaw status --deep` — asks the running gateway for a live health probe (`health` with `probe:true`), including per-account channel probes when supported.
- `openclaw health` — asks the running gateway for its health snapshot (WS-only; no direct channel sockets from the CLI).
- `openclaw health --verbose` — forces a live health probe and prints gateway connection details.
- `openclaw health --json` — machine-readable health snapshot output.
- Send `/status` as a standalone message in WhatsApp/WebChat to get a status reply without invoking the agent.
- Logs: tail `/tmp/openclaw/openclaw-*.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

For Discord and other chat providers, session rows are not socket liveness.
`openclaw sessions`, Gateway `sessions.list`, and the agent `sessions_list` tool
read stored conversation state. A provider can reconnect and show healthy channel
status before any new session row is materialized. Use the channel status and
health commands above for live connectivity checks.

## Deep diagnostics

- Creds on disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Note: the QR login flow auto-restarts once for status 515 after pairing.)
- Diagnostics are enabled by default. The gateway records operational facts unless `diagnostics.enabled: false` is set. Memory events record RSS/heap byte counts, threshold pressure, and growth pressure. Critical memory pressure logs through the gateway logger. When `diagnostics.memoryPressureSnapshot: true` is set, critical memory pressure also writes a pre-OOM stability bundle with V8 heap stats, Linux cgroup counters when available, active resource counts, and the largest session/transcript files by redacted relative path. Liveness warnings record event-loop delay, event-loop utilization, CPU-core ratio, and active/waiting/queued session counts when the process is running but saturated. Oversized-payload events record what was rejected, truncated, or chunked, plus sizes and limits when available. They do not record the message text, attachment contents, webhook body, raw request or response body, tokens, cookies, or secret values. The same heartbeat starts the bounded stability recorder, which is available through `openclaw gateway stability` or the `diagnostics.stability` Gateway RPC. Fatal Gateway exits, shutdown timeouts, and restart startup failures persist the latest recorder snapshot under `~/.openclaw/logs/stability/` when events exist; critical memory pressure does too only when `diagnostics.memoryPressureSnapshot: true` is set. Inspect the newest saved bundle with `openclaw gateway stability --bundle latest`.
- For bug reports, run `openclaw gateway diagnostics export` and attach the generated zip. The export combines a Markdown summary, the newest stability bundle, sanitized log metadata, sanitized Gateway status/health snapshots, and config shape. It is meant to be shared: chat text, webhook bodies, tool outputs, credentials, cookies, account/message identifiers, and secret values are omitted or redacted. See [Diagnostics Export](/gateway/diagnostics).

## Health monitor config

- `gateway.channelHealthCheckMinutes`: how often the gateway checks channel health. Default: `5`. Set `0` to disable health-monitor restarts globally.
- `gateway.channelStaleEventThresholdMinutes`: how long a connected channel can stay idle before the health monitor treats it as stale and restarts it. Default: `30`. Keep this greater than or equal to `gateway.channelHealthCheckMinutes`.
- `gateway.channelMaxRestartsPerHour`: rolling one-hour cap for health-monitor restarts per channel/account. Default: `10`.
- `channels.<provider>.healthMonitor.enabled`: disable health-monitor restarts for a specific channel while leaving global monitoring enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: multi-account override that wins over the channel-level setting.
- These per-channel overrides apply to the built-in channel monitors that expose them today: Discord, Google Chat, iMessage, Microsoft Teams, Signal, Slack, Telegram, and WhatsApp.

## Uptime monitoring

External uptime monitoring services should use the dedicated `/health` endpoint, not `/v1/chat/completions`.

- **DO use:** `GET /health` — instant response, no session created, no LLM call, returns `{"ok":true,"status":"live"}`
- **DON'T use:** `/v1/chat/completions` for health checks — each request creates a full agent session with skill snapshot, context assembly, and LLM calls

### Gateway readiness (`/readyz`)

The `/readyz` endpoint is designed for Kubernetes readiness probes and similar
orchestrator health checks. It reports not-ready during:

- Startup sidecar settling
- Gateway draining for restart
- Channel health failures (disconnected, restart-exhausted)
- **Workspace disk failure** — when the workspace directory is not writable (e.g.
  `ENOSPC`, permissions), `/readyz` returns a `workspace-disk` failure. This
  prevents Kubernetes from routing traffic to a pod that cannot persist
  sessions, transcripts, or media.

The workspace check is only active when a `workspaceDir` is configured (the
default in gateway/server deployments). It writes and removes a temporary probe
file on each check; the 1s cache keeps I/O overhead negligible.

When no `x-openclaw-session-key` header or `user` field is provided, `/v1/chat/completions` generates a new random session for each request. Monitoring services that ping every 15 minutes create ~96 sessions/day, each consuming 4–22KB. Over time this causes session store bloat and can lead to context window overflow.

### Monitoring service setup examples

- **BetterStack:** Set health check URL to `https://<your-gateway-host>:<port>/health`
- **UptimeRobot:** Add a new HTTP monitor with URL `https://<your-gateway-host>:<port>/health`
- **Generic:** Any HTTP GET to `/health` returns 200 with `{"ok":true}` when the gateway is healthy

## When something fails

- `logged out` or status 409–515 → relink with `openclaw channels logout` then `openclaw channels login`.
- Gateway unreachable → start it: `openclaw gateway --port 18789` (use `--force` if the port is busy).
- No inbound messages → confirm linked phone is online and the sender is allowed (`channels.whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedicated "health" command

`openclaw health` asks the running gateway for its health snapshot (no direct channel
sockets from the CLI). By default it can return a fresh cached gateway snapshot; the
gateway then refreshes that cache in the background. `openclaw health --verbose` forces
a live probe instead. The command reports linked creds/auth age when available,
per-channel probe summaries, session-store summary, and a probe duration. It exits
non-zero if the gateway is unreachable or the probe fails/timeouts.

Options:

- `--json`: machine-readable JSON output
- `--timeout <ms>`: override the default 10s probe timeout
- `--verbose`: force a live probe and print gateway connection details
- `--debug`: alias for `--verbose`

The health snapshot includes: `ok` (boolean), `ts` (timestamp), `durationMs` (probe time), per-channel status, agent availability, and session-store summary.

## Related

- [Gateway runbook](/gateway)
- [Diagnostics export](/gateway/diagnostics)
- [Gateway troubleshooting](/gateway/troubleshooting)
