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
| Gateway protocol connectivity | WS control plane (`connect`, events, session/gateway methods) | `Partial` | Rust bridge connects and consumes action-like frames, emits `security.decision`; does not implement full RPC method set. |
| Full Gateway replacement | Sessions, presence, routing, config mutations, cron/webhooks, control UI serving | `Not Started` | Still provided by upstream TypeScript Gateway. |
| Session model | `main` session, group isolation, activation/queue policies, reply-back | `Partial` | Session state counters + last-decision persistence added; scheduler/routing parity still pending. |
| Channel integrations | WhatsApp, Telegram, Discord, Slack, IRC, Signal, Google Chat, Teams, Matrix, etc. | `Deferred` | Kept on upstream Gateway; no Rust adapters yet. |
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
| Channel driver abstraction | Channel-specific frame parsing adapters | `Partial` | Trait-based registry added with first `discord` + generic drivers. |
| Quarantine records | Persist blocked action payloads for forensics | `Implemented` | Append-only JSON files in configured quarantine directory. |
| Backpressure + memory controls | Bounded worker concurrency, queue cap, eval timeout, memory metrics | `Implemented` | Semaphore + queue bounds + timeout + Linux RSS sampler. |
| Test coverage (Rust) | Unit/integration validation for core safety/runtime behavior | `Partial` | Core security and bridge path covered; no end-to-end Gateway/channel matrix yet. |
| Dockerized validation | Containerized CI-style runtime test matrix | `Not Started` | Docker Desktop installed on this machine but daemon not running yet. |

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
  - state store (SQLite WAL) for scheduler/session hot paths (JSON state store implemented as interim step)
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
3. Migrate JSON session state store to SQLite WAL backend for larger deployments.
4. Add additional channel drivers (Telegram/Slack/WhatsApp) behind the shared adapter trait.
