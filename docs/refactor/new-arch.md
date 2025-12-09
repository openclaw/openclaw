# New Gateway Architecture – Implementation Plan (detailed)

Last updated: 2025-12-09

Goal: replace legacy relay/stdin/TCP control with a single WebSocket Gateway, typed protocol, and first-frame snapshot. No backward compatibility.

---

## Phase 0 — Foundations
- **Naming**: CLI subcommand `clawdis gateway`; internal namespace `Gateway`.
- **Protocol folder**: create `protocol/` for schemas and build artifacts. ✅ `src/gateway/protocol`.
- **Schema tooling**:
  - Prefer **TypeBox** (or ArkType) as source-of-truth types. ✅ TypeBox in `schema.ts`.
  - `pnpm protocol:gen`:
    1) emits JSON Schema (`dist/protocol.schema.json`),
    2) runs quicktype → Swift `Codable` models (`apps/macos/Sources/ClawdisProtocol/Protocol.swift`). ✅
  - AJV compile step for server validators. ✅
- **CI**: add a job that fails if schema or generated Swift is stale. ✅ `pnpm protocol:check` (runs gen + git diff).

## Phase 1 — Protocol specification
- Frames (WS text JSON, all with explicit `type`):
  - `hello {type:"hello", minProtocol, maxProtocol, client:{name,version,platform,mode,instanceId}, caps, auth:{token?}, locale?, userAgent?}`
  - `hello-ok {type:"hello-ok", protocol:<chosen>, server:{version,commit,host,connId}, features:{methods,events}, snapshot:{presence[], health, stateVersion:{presence,health}, uptimeMs}, policy:{maxPayload, maxBufferedBytes, tickIntervalMs}}`
  - `hello-error {type:"hello-error", reason, expectedProtocol, minClient}`
  - `req {type:"req", id, method, params?}`
  - `res {type:"res", id, ok, payload?, error?}` where `error` = `{code,message,details?,retryable?,retryAfterMs?}`
  - `event {type:"event", event, payload, seq?, stateVersion?}` (presence/tick/shutdown/agent)
  - `close` (standard WS close codes; policy uses 1008 for slow consumer/unauthorized, 1012/1001 for restart)
- Payload types:
  - `PresenceEntry {host, ip, version, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId?}`
  - `HealthSnapshot` (match existing `clawdis health --json` fields)
  - `AgentEvent` (streamed tool/output; `{runId, seq, stream, data, ts}`)
  - `TickEvent {ts}`
  - `ShutdownEvent {reason, restartExpectedMs?}`
  - Error codes: `NOT_LINKED`, `AGENT_TIMEOUT`, `INVALID_REQUEST`, `UNAVAILABLE`.
- Error shape: `{code, message, details?, retryable?, retryAfterMs?}`
- Rules:
  - First frame must be `type:"hello"`; otherwise close. Add handshake timeout (e.g., 3s) for silent clients.
  - Negotiate protocol: server picks within `[minProtocol,maxProtocol]`; if none, send `hello-error`.
  - Protocol version bump on breaking changes; `hello-ok` must include `minClient` when needed.
  - `stateVersion` increments for presence/health to drop stale deltas.
  - Stable IDs: client sends `instanceId`; server issues per-connection `connId` in `hello-ok`; presence entries may include `instanceId` to dedupe reconnects.
  - Token-based auth: bearer token in `auth.token`; required except for loopback development.
  - Presence is primarily connection-derived; client may add hints (e.g., lastInputSeconds); entries expire via TTL to keep the map bounded (e.g., 5m TTL, max 200 entries).
  - Idempotency keys: required for `send` and `agent` to safely retry after disconnects.
  - Size limits: bound first-frame size by `maxPayload`; reject early if exceeded.
  - Close on any non-JSON or wrong `type` before hello.
  - Per-op idempotency keys: client SHOULD supply an explicit key per `send`/`agent`; if omitted, server may derive a scoped key from `instanceId+connId`, but explicit keys are safer across reconnects.
  - Locale/userAgent are informational; server may log them for analytics but must not rely on them for access control.

## Phase 2 — Gateway WebSocket server
- New module `src/gateway/server.ts`:
  - Bind 127.0.0.1:18789 (configurable).
  - On connect: validate `hello`, send `hello-ok` with snapshot, start event pump.
  - Per-connection queues with backpressure (bounded; drop oldest non-critical).
  - WS-level caps: set `maxPayload` to cap frame size before JSON parse.
  - Emit `tick` every N seconds when idle (or WS ping/pong if adequate).
  - Emit `shutdown` before exit; then close sockets.
- Methods implemented:
  - `health`, `status`, `system-presence`, `system-event`, `send`, `agent`.
  - Optional: `set-heartbeats` removed/renamed if heartbeat concept is retired.
- Events implemented:
  - `agent`, `presence` (deltas, with `stateVersion`), `tick`, `shutdown`.
  - All events include `seq` for loss/out-of-order detection.
- Logging: structured logs on connect/close/error; include client fingerprint.
- Slow consumer policy:
  - Per-connection outbound queue limit (bytes/messages). If exceeded, drop non-critical events (presence/tick) or close with a policy violation / retryable code; clients reconnect with backoff.
- Handshake edge cases:
  - Close on handshake timeout.
  - Close on over-limit first frame (maxPayload).
  - Close immediately on non-JSON or wrong `type` before hello.
  - Default guardrails: `maxPayload` ~512 KB, handshake timeout ~3 s, outbound buffered amount cap ~1.5 MB (tune as you implement).
- Dedupe cache: bound TTL (~5m) and max size (~1000 entries); evict oldest first (LRU) to prevent memory growth.

## Phase 3 — Gateway CLI entrypoint
- Add `clawdis gateway` command in CLI program:
  - Reads config (port, WS options).
  - Foreground process; exit non-zero on fatal errors.
  - Flags: `--port`, `--no-tick` (optional), `--log-json` (optional).
- System supervision docs for launchd/systemd (see `gateway.md`).

## Phase 4 — Presence/health snapshot & stateVersion
- `hello-ok.snapshot` includes:
  - `presence[]` (current list)
  - `health` (full snapshot)
  - `stateVersion {presence:int, health:int}`
  - `uptimeMs`
  - `policy {maxPayload, maxBufferedBytes, tickIntervalMs}`
- Emit `presence` deltas with updated `stateVersion.presence`.
- Emit `tick` to indicate liveness when no other events occur.
- Keep `health` method for manual refresh; not required after connect.
 - Presence expiry: prune entries older than TTL; enforce a max map size; include `stateVersion` in presence events.

## Phase 5 — Clients migration
- **macOS app**:
  - Replace stdio/SSH RPC with WS client (tunneled via SSH/Tailscale for remote). ✅ AgentRPC/ControlChannel now use Gateway WS.
  - Implement handshake, snapshot hydration, subscriptions to `presence`, `tick`, `agent`, `shutdown`. ✅ snapshot + presence events broadcast to InstancesStore; agent events still to wire to UI if desired.
  - Remove immediate `health/system-presence` fetch on connect. ✅ presence hydrated from snapshot; periodic refresh kept as fallback.
  - Handle `hello-error` and retry with backoff if version/token mismatched. ✅ macOS GatewayChannel reconnects with exponential backoff.
- **CLI**:
  - Add lightweight WS client helper for `status/health/send/agent` when Gateway is up. ✅ `gw:*` commands use the Gateway over WS.
  - Consider a “local only” flag to avoid accidental remote connects. (optional; not needed with tunnel-first model.)
- **WebChat backend**:
  - Single WS to Gateway; seed UI from snapshot; forward `presence/tick/agent` to browser. ✅ implemented via `GatewayClient` in `webchat/server.ts`.
  - Fail fast if handshake fails; no fallback transports. ✅ (webchat returns gateway unavailable)

## Phase 6 — Send/agent path hardening
- Ensure only the Gateway can open Baileys; no IPC fallback.
- `send` executes in-process; respond with explicit result/error, not via heartbeat.
- `agent` spawns Tau/Pi; respond quickly with `{runId,status:"accepted"}` (ack); stream `event:agent {runId, seq, stream, data, ts}`; final `res:agent {runId, status:"ok"|"error", summary}` completes request (idempotent via key).
- Idempotency: side-effecting methods (`send`, `agent`) accept an idempotency key; keep a short-lived dedupe cache to avoid double-send on client retries. Client retry flow: on timeout/close, retry with same key; Gateway returns cached result when available; cache TTL ~5m and bounded.
- Agent stream ordering: enforce monotonic `seq` per runId; if gap detected by server, terminate stream with error; if detected by client, issue a retry with same idempotency key.
 - Send response shape: `{messageId?, toJid?, error?}` and always include `runId` when available for traceability.

## Phase 7 — Keepalive and shutdown semantics
- Keepalive: `tick` events (or WS ping/pong) at fixed interval; clients treat missing ticks as disconnect and reconnect.
- Shutdown: send `event:shutdown {reason, restartExpectedMs?}` then close sockets; clients auto-reconnect.
- Restart semantics: close sockets with a standard retryable close code; on reconnect, `hello-ok` snapshot must be sufficient to rebuild UI without event replay.
  - Use a standard close code (e.g., 1012 service restart or 1001 going away) for planned restart; 1008 policy violation for slow consumers.
  - Include `policy` in `hello-ok` so clients know the tick interval and buffer limits to tune their expectations.

## Phase 8 — Cleanup and deprecation
- Retire `clawdis rpc` as default path; keep only if explicitly requested (documented as legacy).
- Remove reliance on `src/infra/control-channel.ts` for new clients; mark as legacy or delete after migration. ✅ file removed; mac app now uses Gateway WS.
- Update README, docs (`architecture.md`, `gateway.md`, `webchat.md`) to final shapes; remove `control-api.md` references if obsolete.
- Presence hygiene:
  - Presence derived primarily from connection (server-fills host/ip/version/connId/instanceId); allow client hints (e.g., lastInputSeconds).
  - Add TTL/expiry; prune to keep map bounded (e.g., 5m TTL, max 200 entries).

## Edge cases and ordering
- Event ordering: all events carry `seq`; clients detect gaps and should re-fetch snapshot (or targeted refresh) on gap.
- Partial handshakes: if client connects and never sends hello, server closes after handshake timeout.
- Garbage/oversize first frame: bounded by `maxPayload`; server closes immediately on parse failure.
- Duplicate delivery on reconnect: clients must send idempotency keys; Gateway dedupe cache prevents double-send/agent execution.
- Snapshot sufficiency: `hello-ok.snapshot` must contain enough to render UI after reconnect without event replay.
- Client reconnect guidance: exponential backoff with jitter; reuse same `instanceId` across reconnects to avoid duplicate presence; resend idempotency keys for in-flight sends/agents; on seq gap, issue `health`/`system-presence` refresh.
- Presence TTL/defaults: set a concrete TTL (e.g., 5 minutes) and prune periodically; cap the presence map size with LRU if needed.
- Replay policy: if seq gap detected, server does not replay; clients must pull fresh `health` + `system-presence` and continue.

## Phase 9 — Testing & validation
- Unit: frame validation, handshake failure, auth/token, stateVersion on presence events, agent stream fanout, send dedupe. ✅
- Integration: connect → snapshot → req/res → streaming agent → shutdown. ✅ Covered in gateway WS tests (hello/health/status/presence, agent ack+final, shutdown broadcast).
- Load: multiple concurrent WS clients; backpressure behavior under burst. ✅ Basic fanout test with 3 clients receiving presence broadcast; heavier soak still recommended.
- Mac app smoke: presence/health render from snapshot; reconnect on tick loss. (Manual: open Instances tab, verify snapshot after connect, induce seq gap by toggling wifi, ensure UI refreshes.)
- WebChat smoke: snapshot seed + event updates; tunnel scenario. ✅ Offline snapshot harness in `src/webchat/server.test.ts` (mock gateway) now passes; live tunnel still recommended for manual.
- Idempotency tests: retry send/agent with same key after forced disconnect; expect deduped result. ✅ send + agent dedupe + reconnect retry covered in gateway tests.
- Seq-gap handling: ✅ clients now detect seq gaps (GatewayClient + mac GatewayChannel) and refresh health/presence (webchat) or trigger UI refresh (mac). Load-test still optional.

## Phase 10 — Rollout
- Version bump; release notes: breaking change to control plane (WS only).
- Ship launchd/systemd templates for `clawdis gateway`.
- Recommend Tailscale/SSH tunnel for remote access; no additional auth layer assumed in this model.

---

- Quick checklist
- [x] Protocol types & schemas (TS + JSON Schema + Swift via quicktype)
- [x] AJV validators wired
- [x] WS server with hello → snapshot → events
- [x] Tick + shutdown events
- [x] stateVersion + presence deltas
- [x] Gateway CLI command
- [x] macOS app WS client (Gateway WS for control; presence events live; agent stream UI pending)
- [x] WebChat WS client
- [x] Remove legacy stdin/TCP paths from default flows (file removed; mac app/CLI on Gateway)
- [x] Tests (unit/integration/load) — unit + integration + basic fanout/reconnect; heavier load/soak optional
- [x] Docs updated and legacy docs flagged
