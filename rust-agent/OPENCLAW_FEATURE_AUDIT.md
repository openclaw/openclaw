# OpenClaw Rust Rewrite Feature Audit

Date: 2026-02-17  
Audit basis: `openclaw/openclaw` `main` docs and README in this workspace

## Scope

This audit compares upstream OpenClaw capabilities with the current Rust implementation in `rust-agent/`.

Current architecture status:

- Rust currently acts as a **Gateway-compatible defender runtime**.
- It is **not yet** a full replacement for the TypeScript Gateway/runtime/channel stack.

Status legend:

- `Implemented`: Working in current Rust code.
- `Partial`: Exists but limited scope compared to upstream.
- `Not Started`: No Rust implementation yet.
- `Deferred`: Intentionally kept in upstream Gateway for now.

## Feature Matrix

- `Runtime portability`: Upstream OpenClaw feature surface is macOS/Linux/Windows workflow and Linux service deployment. Rust status is `Implemented`. Notes: Rust toolchain pinned to 1.83; Ubuntu build script and systemd user unit included.
- `Gateway protocol connectivity`: Upstream OpenClaw feature surface is WS control plane (`connect`, events, session/gateway methods). Rust status is `Partial`. Notes: Rust bridge uses typed frame helpers (`req`/`resp`/`event`), method-family classification, known-method registry, and RPC dispatcher coverage for gateway introspection (`health`, `status`), usage summaries (`usage.status`, `usage.cost`), system control parity (`last-heartbeat`, `set-heartbeats`, `system-presence`, `system-event`, `wake`), talk/channel control parity (`talk.config`, `talk.mode`, `channels.status`, `channels.logout`), web login parity (`web.login.start`, `web.login.wait` with in-memory QR session lifecycle), update parity (`update.run` with restart-sentinel shaped payload), wizard parity (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status` with single-running-session guard), model/agent control parity (`models.list`, `agents.list`, `agents.create`, `agents.update`, `agents.delete`, `agents.files.list`, `agents.files.get`, `agents.files.set`), skills control parity (`skills.status`, `skills.bins`, `skills.install`, `skills.update` with API-key normalization + in-memory config state), cron RPC parity (`cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` with bounded in-memory run logs), config/log parity (`config.get`, `config.set`, `config.patch`, `config.apply`, `config.schema`, `logs.tail`), plus session control methods (`sessions.list`, `sessions.preview`, `sessions.patch`, `sessions.resolve`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`, `sessions.history`, `sessions.send`, `session.status`); full RPC dispatch parity still pending.
- `Full Gateway replacement`: Upstream OpenClaw feature surface is sessions, presence, routing, config mutations, cron/webhooks, and control UI serving. Rust status is `Partial`. Notes: Rust now covers a broad in-memory gateway RPC surface (including cron CRUD/run/runs/status), but TS still owns durable cron scheduling, webhook transport side effects, and UI serving/runtime orchestration.
- `Session model`: Upstream OpenClaw feature surface is `main` session, group isolation, activation/queue policies, and reply-back. Rust status is `Partial`. Notes: First-pass per-session scheduler now supports `followup`/`steer`/`collect` queue modes plus group activation gating (`mention`/`always`), with state counters + bounded in-memory session transcript (`sessions.history`/`sessions.send`) + session usage aggregation (`sessions.usage`, date-range inputs, context-weight placeholder, and extended envelope fields for totals/actions/aggregates) + filtered listing (`includeGlobal`, `includeUnknown`, `agentId`, `search`, `label`, `spawnedBy`) + optional list hint fields (`displayName`, `derivedTitle`, `lastMessagePreview`, `lastAccountId`, `deliveryContext`, `totalTokensFresh`) + metadata-aware session resolution (`label`, `spawnedBy`) + `sessions.history` lookup parity via `key` aliases and `sessionId` + `sessions.preview` output-key parity for requested aliases + explicit per-session `sessionId` tracking (including `sessions.resolve` by `sessionId` and `sessions.reset` ID rotation) + canonical alias/short-key normalization for session RPC lookups and mutations + reset/compact parameter/default parity (`reason` = `new|reset`, `maxLines >= 1`, default compact window 400) + extended `sessions.patch` parity (`key`, `ok/path/key/entry`, tuning fields, canonical value normalization, explicit `null` clears, `reasoningLevel/responseUsage` `"off"` clear semantics, `sendPolicy` constrained to `allow|deny|null`, label uniqueness, consistent label length constraints (max 64) across patch/list/resolve without silent truncation, subagent-only immutable `spawnedBy`/`spawnDepth`) + `sessions.delete`/`sessions.compact` envelope parity (`path`, `archived`) including `deleteTranscript` handling + last-decision persistence (JSON default, optional SQLite WAL); advanced routing/reply-back parity still pending.
- `Channel integrations`: Upstream OpenClaw feature surface is WhatsApp, Telegram, Discord, Slack, IRC, Signal, Google Chat, Teams, Matrix, etc. Rust status is `Partial`. Notes: Rust adapter scaffold includes `whatsapp`, `telegram`, `slack`, `discord`, and generic extraction; full channel runtime parity remains pending.
- `Tool execution layer`: Upstream OpenClaw feature surface is `exec`, `process`, `apply_patch`, browser/canvas/nodes, message, gateway, and sessions\_\* methods. Rust status is `Deferred`. Notes: Rust currently evaluates risk for actions instead of hosting the tool layer.
- `Nodes + device features`: Upstream OpenClaw feature surface is macOS/iOS/Android nodes, camera/screen/location/system.run, and canvas A2UI. Rust status is `Deferred`. Notes: No node host in Rust yet.
- `Voice stack`: Upstream OpenClaw feature surface is Voice Wake, Talk Mode, and audio I/O flows. Rust status is `Not Started`. Notes: Out of current Rust scope.
- `Model/provider layer`: Upstream OpenClaw feature surface is provider catalog, auth profiles, and failover/routing. Rust status is `Deferred`. Notes: Still upstream-managed. Rust does not host model providers today.
- `Prompt-injection defense`: Upstream OpenClaw feature surface is prompt pattern detection plus exfiltration/bypass heuristics. Rust status is `Implemented`. Notes: `prompt_guard.rs` with pattern scoring and heuristic boosts.
- `Command safety defense`: Upstream OpenClaw feature surface is blocked regex patterns plus allow-prefix policy and escalation/pipe checks. Rust status is `Implemented`. Notes: `command_guard.rs` with risk scoring model.
- `Host integrity defense`: Upstream OpenClaw feature surface is baseline hashing and tamper detection on protected paths. Rust status is `Implemented`. Notes: `host_guard.rs` checks hash drift/missing files.
- `VirusTotal integration`: Upstream OpenClaw feature surface is external URL/file reputation signal. Rust status is `Implemented`. Notes: `virustotal.rs` supports URL/file hash lookup and risk mapping.
- `Decision policy engine`: Upstream OpenClaw feature surface is risk aggregation to `allow`/`review`/`block` with thresholds. Rust status is `Implemented`. Notes: `security/mod.rs` classifier with `audit_only` override.
- `Tool/channel policy controls`: Upstream OpenClaw feature surface is per-tool policy floors and channel-aware risk weighting. Rust status is `Implemented`. Notes: `tool_policies`, `tool_risk_bonus`, and `channel_risk_bonus` are configurable in TOML.
- `Idempotency dedupe`: Upstream OpenClaw feature surface is repeated action/request suppression. Rust status is `Partial`. Notes: Request id/signature idempotency cache added with TTL + bounded entries.
- `Channel driver abstraction`: Upstream OpenClaw feature surface is channel-specific frame parsing adapters. Rust status is `Partial`. Notes: Trait-based registry added with `whatsapp`, `telegram`, `slack`, `discord`, and generic drivers.
- `Quarantine records`: Upstream OpenClaw feature surface is persisting blocked action payloads for forensics. Rust status is `Implemented`. Notes: Append-only JSON files in configured quarantine directory.
- `Backpressure + memory controls`: Upstream OpenClaw feature surface is bounded worker concurrency, queue cap, eval timeout, and memory metrics. Rust status is `Implemented`. Notes: Semaphore + queue bounds + timeout + Linux RSS sampler.
- `Test coverage (Rust)`: Upstream OpenClaw feature surface is unit/integration validation for core safety/runtime behavior. Rust status is `Partial`. Notes: Core security/bridge/channel adapters/replay harness covered, including bridge-level mention-activation and steer-queue semantics; full end-to-end Gateway/channel matrix still pending.
- `Dockerized validation`: Upstream OpenClaw feature surface is containerized CI-style runtime test matrix. Rust status is `Partial`. Notes: Added Docker parity smoke harness (`deploy/Dockerfile.parity`, run scripts) for default + `sqlite-state`; full compose-based Gateway/channel parity environment still pending.

## Custom Defender Goal Coverage

### Goal 1: Ubuntu 20.04 Rust runtime

- `Implemented` for build/deploy baseline:
  - `scripts/build-ubuntu20.sh`
  - `deploy/openclaw-agent-rs.service`

### Goal 2: Faster and more RAM-efficient behavior

- `Implemented` in phase-1 runtime controls:
  - bounded worker pool
  - bounded queue
  - per-eval timeout
  - low-overhead Linux RSS sampling

- `Partial` for deeper optimizations:
  - pooled binary event buffers
  - scheduler/session hot-path tuning and indexing on SQLite backend for larger deployments
  - throughput benchmarking vs upstream runtime

### Goal 3: Defender AI + VirusTotal hardening against prompt injection and host compromise

- `Implemented`:
  - prompt-injection scoring
  - command risk scoring
  - host file-integrity checks
  - VirusTotal URL/file signal fusion
  - audit-only rollout mode
  - quarantine artifacts

- `Partial`:
  - no cryptographic signed policy bundles yet
  - no kernel/EDR process telemetry ingestion
  - no remote attestation of runtime binary yet

## Immediate Next Build Targets

1. Add Docker compose profile for: Gateway + Rust defender + mock action producer + assertor.
2. Expand policy engine with tamper-evident signed policy bundle loading.
3. Expand session model parity to include group isolation, activation policy tuning, and reply-back semantics.
4. Expand channel runtime parity beyond extraction adapters (transport lifecycle, retry/backoff, webhook ingress).
