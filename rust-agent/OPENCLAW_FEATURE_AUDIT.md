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

| Area | Upstream OpenClaw Feature Surface | Rust Status | Notes |
|---|---|---|---|
| Runtime portability | macOS/Linux/Windows workflow; Linux service deployment | `Implemented` | Rust toolchain pinned to 1.83; Ubuntu build script and systemd user unit included. |
| Gateway protocol connectivity | WS control plane (`connect`, events, session/gateway methods) | `Partial` | Rust bridge uses typed frame helpers (`req`/`resp`/`event`), method-family classification, known-method registry, and RPC dispatcher coverage for gateway introspection (`health`, `status`), usage summaries (`usage.status`, `usage.cost`), system control parity (`last-heartbeat`, `set-heartbeats`, `system-presence`, `system-event`, `wake`), talk/channel control parity (`talk.config`, `talk.mode`, `channels.status`, `channels.logout`), model/agent control parity (`models.list`, `agents.list`, `agents.create`, `agents.update`, `agents.delete`, `agents.files.list`, `agents.files.get`, `agents.files.set`), config/log parity (`config.get`, `config.set`, `config.patch`, `config.apply`, `config.schema`, `logs.tail`), plus session control methods (`sessions.list`, `sessions.preview`, `sessions.patch`, `sessions.resolve`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`, `sessions.history`, `sessions.send`, `session.status`); full RPC dispatch parity still pending. |
| Full Gateway replacement | Sessions, presence, routing, config mutations, cron/webhooks, control UI serving | `Not Started` | Still provided by upstream TypeScript Gateway. |
| Session model | `main` session, group isolation, activation/queue policies, reply-back | `Partial` | First-pass per-session scheduler now supports `followup`/`steer`/`collect` queue modes plus group activation gating (`mention`/`always`), with state counters + bounded in-memory session transcript (`sessions.history`/`sessions.send`) + session usage aggregation (`sessions.usage`, date-range inputs, context-weight placeholder, and extended envelope fields for totals/actions/aggregates) + filtered listing (`includeGlobal`, `includeUnknown`, `agentId`, `search`, `label`, `spawnedBy`) + optional list hint fields (`displayName`, `derivedTitle`, `lastMessagePreview`, `lastAccountId`, `deliveryContext`, `totalTokensFresh`) + metadata-aware session resolution (`label`, `spawnedBy`) + `sessions.history` lookup parity via `key` aliases and `sessionId` + `sessions.preview` output-key parity for requested aliases + explicit per-session `sessionId` tracking (including `sessions.resolve` by `sessionId` and `sessions.reset` ID rotation) + canonical alias/short-key normalization for session RPC lookups and mutations + reset/compact parameter/default parity (`reason` = `new|reset`, `maxLines >= 1`, default compact window 400) + extended `sessions.patch` parity (`key`, `ok/path/key/entry`, tuning fields, canonical value normalization, explicit `null` clears, `reasoningLevel/responseUsage` `"off"` clear semantics, `sendPolicy` constrained to `allow|deny|null`, label uniqueness, consistent label length constraints (max 64) across patch/list/resolve without silent truncation, subagent-only immutable `spawnedBy`/`spawnDepth`) + `sessions.delete`/`sessions.compact` envelope parity (`path`, `archived`) including `deleteTranscript` handling + last-decision persistence (JSON default, optional SQLite WAL); advanced routing/reply-back parity still pending. |
| Channel integrations | WhatsApp, Telegram, Discord, Slack, IRC, Signal, Google Chat, Teams, Matrix, etc. | `Partial` | Rust adapter scaffold includes `whatsapp`, `telegram`, `slack`, `discord`, and generic extraction; full channel runtime parity remains pending. |
| Tool execution layer | `exec`, `process`, `apply_patch`, browser/canvas/nodes, message, gateway, sessions_* | `Deferred` | Rust currently evaluates risk for actions instead of hosting the tool layer. |
| Nodes + device features | macOS/iOS/Android nodes, camera/screen/location/system.run, canvas A2UI | `Deferred` | No node host in Rust yet. |
| Voice stack | Voice Wake, Talk Mode, audio I/O flows | `Not Started` | Out of current Rust scope. |
| Model/provider layer | provider catalog, auth profiles, failover/routing | `Deferred` | Still upstream-managed. Rust does not host model providers today. |
| Prompt-injection defense | Prompt pattern detection + exfiltration/bypass heuristics | `Implemented` | `prompt_guard.rs` with pattern scoring and heuristic boosts. |
| Command safety defense | Blocked regex patterns + allow-prefix policy + escalation/pipe checks | `Implemented` | `command_guard.rs` with risk scoring model. |
| Host integrity defense | Baseline hashing and tamper detection on protected paths | `Implemented` | `host_guard.rs` checks hash drift/missing files. |
| VirusTotal integration | External URL/file reputation signal | `Implemented` | `virustotal.rs` supports URL/file hash lookup and risk mapping. |
| Decision policy engine | Risk aggregation -> `allow/review/block` with thresholds | `Implemented` | `security/mod.rs` classifier with `audit_only` override. |
| Tool/channel policy controls | Per-tool policy floors and channel-aware risk weighting | `Implemented` | `tool_policies`, `tool_risk_bonus`, and `channel_risk_bonus` are configurable in TOML. |
| Idempotency dedupe | Repeated action/request suppression | `Partial` | Request id/signature idempotency cache added with TTL + bounded entries. |
| Channel driver abstraction | Channel-specific frame parsing adapters | `Partial` | Trait-based registry added with `whatsapp`, `telegram`, `slack`, `discord`, and generic drivers. |
| Quarantine records | Persist blocked action payloads for forensics | `Implemented` | Append-only JSON files in configured quarantine directory. |
| Backpressure + memory controls | Bounded worker concurrency, queue cap, eval timeout, memory metrics | `Implemented` | Semaphore + queue bounds + timeout + Linux RSS sampler. |
| Test coverage (Rust) | Unit/integration validation for core safety/runtime behavior | `Partial` | Core security/bridge/channel adapters/replay harness covered, including bridge-level mention-activation and steer-queue semantics; full end-to-end Gateway/channel matrix still pending. |
| Dockerized validation | Containerized CI-style runtime test matrix | `Partial` | Added Docker parity smoke harness (`deploy/Dockerfile.parity`, run scripts) for default + `sqlite-state`; full compose-based Gateway/channel parity environment still pending. |

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
