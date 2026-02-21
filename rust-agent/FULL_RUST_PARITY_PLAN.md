# OpenClaw Full Rust Parity Plan

Date: 2026-02-17  
Scope baseline: upstream `openclaw/openclaw` `main` + current `rust-agent/` implementation (`c3e646bcd`)

## 1) Objective

Deliver a production Rust implementation that can fully replace the current TypeScript OpenClaw runtime stack while preserving feature behavior and operational compatibility across:

1. Gateway protocol and runtime behavior.
2. Session model and multi-agent routing.
3. Tool surface and automation behavior.
4. Channel adapters and messaging behavior.
5. Node/device integrations and UI-facing workflows.
6. Model/provider behavior and auth flows.
7. Operational characteristics (reliability, observability, upgrades, security).

## 2) Parity Definition

Feature parity is achieved only when all required checks pass:

| Area        | Parity Requirement                                                                | Evidence                                         |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Protocol    | Rust accepts and emits protocol-equivalent WS frames for supported methods/events | Differential protocol tests against TS snapshots |
| Functional  | Same user-visible outcomes for channels/tools/sessions/nodes                      | End-to-end integration suite and scenario replay |
| Operational | Same or better uptime, restart behavior, migrations, diagnostics                  | Soak tests + ops runbook verification            |
| Performance | Equal or better latency, throughput, and memory under target load                 | Benchmark suite with pass thresholds             |
| Security    | Equal baseline + new defender controls without regressions                        | Security regression suite + threat model checks  |

## 3) Current Baseline

Already implemented in Rust:

1. Gateway-compatible sidecar bridge for action evaluation.
2. Defender pipeline (prompt, command, host integrity, VirusTotal).
3. Per-tool policy floors and tool/channel risk weighting.
4. Idempotency cache and session state persistence (JSON interim store).
5. Trait-based channel adapter scaffold (`discord` + generic fallback).
6. Replay harness with asserted decision outcomes.

Not yet implemented:

1. Full Gateway runtime and RPC surface.
2. Full session scheduler/routing semantics.
3. Full tool runtime parity.
4. Full channel adapter parity.
5. Node/browser/canvas/voice parity runtime in Rust.
6. Provider/auth/catalog parity.
7. Full CLI/control UI parity wiring.

## 4) Target Rust Architecture

Use a crate-based architecture to keep parity work modular:

1. `openclaw-proto`: typed protocol schema, codecs, compatibility adapters.
2. `openclaw-gateway-rs`: WS server, routing, sessions, presence, config, cron/webhooks.
3. `openclaw-agent-rs`: agent runtime, defender, policy engine, idempotency/scheduler.
4. `openclaw-tools-rs`: tool registry/execution, allow/deny profiles, loop detection.
5. `openclaw-channels-rs`: channel adapter trait + provider-specific adapters.
6. `openclaw-nodes-rs`: node pairing/describe/invoke and device command transport.
7. `openclaw-models-rs`: provider abstraction, auth profiles, failover logic.
8. `openclaw-cli-rs`: CLI parity and migration tooling.
9. `openclaw-observability-rs`: structured logs, metrics, traces, health endpoints.

Design rules:

1. Keep protocol wire compatibility first.
2. Feature-flag all parity migrations.
3. Use shadow mode before switching write path.
4. Prefer deterministic state machines over ad-hoc flow.
5. Preserve config compatibility through translation layer.

## 5) Execution Strategy

Run a dual-runtime migration with strict gates:

1. Build Rust subsystem.
2. Run in shadow mode against live TS Gateway events.
3. Compare decisions/events/output against TS golden traces.
4. Enable read-path parity in canary.
5. Enable write-path parity in canary.
6. Roll out gradually by subsystem and channel wave.
7. Decommission TS only after parity scorecard is green.

## 6) Phased Plan

## Phase 0: Program Control and Freeze

Goal: stable parity target and test harness foundation.

Deliverables:

1. Frozen parity manifest mapped to upstream docs/features.
2. Protocol snapshot corpus from TS runtime.
3. CI parity scoreboard (pass/fail by subsystem).

Exit criteria:

1. All parity requirements are measurable.
2. No untracked "implicit behavior" remains.

## Phase 1: Protocol and Schema Parity

Goal: wire-level compatibility.

Deliverables:

1. Typed schemas for connect/events/req/resp/error.
2. Frame normalizers for legacy field aliases.
3. Differential WS test suite against TS traces.

Exit criteria:

1. 100% pass on protocol replay corpus.
2. No unknown frame decode failures in soak tests.

## Phase 2: Gateway Core Runtime

Goal: replace core Gateway runtime internals.

Deliverables:

1. Rust WS gateway server with auth and role handling.
2. Presence and connection lifecycle state.
3. Config load/patch/apply + hot-reload path.
4. Cron/webhook/event dispatch core.

Exit criteria:

1. Gateway can run standalone for core control-plane operations.
2. Config and restart workflows match operationally.

## Phase 3: Session and Routing Parity

Goal: match session semantics and routing behavior.

Deliverables:

1. `main` and group session lifecycle semantics.
2. Queue/activation/reply-back behavior.
3. Multi-agent routing rules by channel/account/peer.
4. Persistent session state backend (SQLite WAL).

Exit criteria:

1. Session behavior replay suite matches TS outcomes.
2. No duplicate handling or reply ordering regressions.

## Phase 4: Tool Runtime Parity

Goal: match tool behavior and policy controls.

Deliverables:

1. Rust tool registry and execution pipeline.
2. `exec/process/read/write/edit/apply_patch` parity.
3. Profiles (`minimal/coding/messaging/full`) and allow/deny precedence.
4. Provider-specific and per-agent tool filtering.
5. Loop detection and guardrail parity.

Exit criteria:

1. Tool invocation transcript parity test is green.
2. Policy evaluation behavior matches for known fixtures.

## Phase 5: Channel Adapter Parity (Wave Plan)

Goal: migrate channels in risk-ordered waves.

Wave 1 (core channels):

1. Telegram
2. WhatsApp
3. Discord
4. Slack
5. Signal
6. WebChat

Wave 2 (important extensions):

1. BlueBubbles
2. Microsoft Teams
3. Google Chat
4. Matrix
5. Zalo/Zalo Personal

Wave 3 (remaining adapters/plugins):

1. IRC
2. Feishu
3. Mattermost
4. LINE
5. Nextcloud Talk
6. Nostr
7. Tlon
8. Twitch

Deliverables per channel:

1. Adapter implementation behind shared trait.
2. Pairing/auth/state persistence parity.
3. Send/edit/delete/react/thread/poll behavior parity where applicable.
4. Group routing/mention gating/chunking parity tests.

Exit criteria:

1. Channel acceptance suite green for each migrated channel.
2. Live canary chat scenarios produce matching behavior.

## Phase 6: Nodes, Browser, Canvas, and Device Flows

Goal: parity for node-centric and UI-visible capabilities.

Deliverables:

1. Node pairing/list/describe/invoke parity.
2. Canvas commands and A2UI flow compatibility.
3. Camera/screen/location/system.run command routing parity.
4. Browser tool orchestration compatibility layer.

Exit criteria:

1. Node command suite is green across supported platforms.
2. Canvas/browser automation scenarios pass parity tests.

## Phase 7: Model Provider and Auth Parity

Goal: equivalent provider behavior and failover flows.

Deliverables:

1. Provider abstraction and model reference handling.
2. Auth profile loading/rotation behavior.
3. Primary/fallback failover semantics.
4. Model allowlist and provider-specific policy enforcement.

Exit criteria:

1. Model selection and failover fixtures match TS behavior.
2. Auth profile migration works without user-visible breakage.

## Phase 8: CLI and Control Surface Parity

Goal: preserve operator workflows and onboarding flows.

Deliverables:

1. Rust CLI command parity for gateway/agent/message/nodes/sessions.
2. `doctor` equivalent checks and migration diagnostics.
3. Control UI compatibility endpoints and config APIs.

Exit criteria:

1. Operator runbooks execute without TS binaries.
2. Existing automation scripts continue to work.

## Phase 9: Performance, Reliability, and Security Hardening

Goal: exceed TS runtime quality bar.

Deliverables:

1. Benchmarks for p50/p95/p99 latency and throughput.
2. Memory profile targets with steady-state and burst load.
3. Crash recovery, reconnection, and backpressure resilience tests.
4. Signed policy bundle loading and tamper-evident policy updates.
5. Security regression suite for injection, command abuse, and host tampering.

Exit criteria:

1. Meets or exceeds target SLOs.
2. Security suite passes with no critical gaps.

## Phase 10: Cutover and Decommission

Goal: complete migration with reversible rollout.

Deliverables:

1. Controlled rollout plan (canary -> staged -> full).
2. Rollback-safe toggles per subsystem.
3. TS decommission checklist and archival.

Exit criteria:

1. Rust runtime is default in production.
2. TS runtime path removed or archived.

## 7) Subsystem Backlog Details

## 7.1 Gateway Core

1. Implement WS accept loop and role-auth handshake.
2. Port req/resp method dispatch table.
3. Add event fanout and backpressure semantics.
4. Add config schema validation and live reload.

## 7.2 Sessions

1. Session identity and namespace model.
2. Session queue processor with ordering guarantees.
3. Group activation and reply-back logic.
4. Persistence layer migration to SQLite WAL.

## 7.3 Tooling

1. Tool registry and manifest loading.
2. Sandboxed execution hosts and approval policies.
3. `process` session management parity.
4. Policy precedence tests (`profile`, `allow`, `deny`, `byProvider`).

## 7.4 Channels

1. Shared adapter trait with capability descriptors.
2. Adapter-specific parser/router implementations.
3. Message normalization and attachment lifecycle.
4. Channel-specific retry/chunking strategy.

## 7.5 Nodes and Device Integrations

1. Pairing request lifecycle and approvals.
2. Capability discovery (`node.describe`) compatibility.
3. `node.invoke` command routing and timeout semantics.
4. Media payload handling parity and caps.

## 7.6 Model Providers

1. Provider registry and model catalog loader.
2. Auth source resolution and profile priority.
3. Request shaping and streaming compatibility.
4. Failover and alias resolution behavior.

## 8) Test Strategy

Required test layers:

1. Unit tests for parser/policy/state machines.
2. Differential protocol replay tests (TS vs Rust outputs).
3. Integration tests with mocked external providers/channels.
4. Docker compose system tests for gateway + agent + fixtures.
5. Soak and chaos tests (disconnects, timeouts, retries, restarts).
6. Performance benchmark suite.
7. Security regression suite.

Required artifacts:

1. Golden trace corpus versioned in repo.
2. Parity scorecard generated in CI for every PR.
3. Release gate report with subsystem pass map.

## 9) Performance and Resource Targets

Initial target SLOs (adjust after baseline measurements):

1. Gateway command handling p95 latency not worse than TS baseline.
2. Defender decision p95 latency under 200 ms for non-networked cases.
3. Memory growth stable in 24h soak with no unbounded queues.
4. Reconnect recovery within 5 seconds after transient disconnect.

## 10) Security Plan for Parity and Improvement

1. Keep upstream-safe defaults for DM pairing and allowlists.
2. Add signed policy bundles and integrity verification.
3. Preserve audit-only mode for safe rollout.
4. Add red-team fixtures for injection and command abuse.
5. Add policy regression tests to prevent accidental drift.

## 11) Rollout and Migration Strategy

1. Shadow mode for each subsystem (observe-only).
2. Read-path enablement in canary.
3. Write-path enablement in canary with rollback switch.
4. Progressive rollout by channel and tenant/workspace.
5. Final cutover after parity scorecard is fully green.

## 12) Risks and Mitigations

| Risk                                      | Impact                      | Mitigation                                               |
| ----------------------------------------- | --------------------------- | -------------------------------------------------------- |
| Hidden TS behavior not documented         | Parity drift                | Expand golden traces from real sessions and channel logs |
| Channel API volatility                    | Breakage during migration   | Adapter isolation + contract tests per channel           |
| Performance regression during parity work | Operational instability     | Continuous perf CI and resource budgets                  |
| Config incompatibility                    | User-facing breakage        | Translation layer + strict validation + migration tool   |
| Long migration window                     | Feature drift with upstream | Freeze windows and regular upstream diff reviews         |

## 13) Definition of Done

Full Rust parity is complete only when:

1. All parity scorecard items are green across required channels/tools/sessions/nodes/providers.
2. Rust runtime runs production traffic as default with no critical regressions.
3. TS runtime is no longer required for normal operations.
4. Rollback path exists but is not actively used in steady state.
