# OpenClaw Agent (Rust)

This directory contains the Rust rewrite foundation for the OpenClaw runtime.

Minimum supported Rust version: `1.83`.

What is implemented now:

- Native Rust runtime suitable for Ubuntu 20.04 deployment.
- Gateway compatibility bridge over OpenClaw's WebSocket protocol.
- Defender pipeline that can block/review suspicious actions before execution.
- VirusTotal lookups (file hash + URL) to add external threat intelligence.
- Host integrity baseline checks for key runtime files.
- Bounded concurrency and queue limits to reduce memory spikes.
- Session FIFO scheduling + decision state tracking + idempotency cache.
- Typed session-key parsing (`main`, `direct`, `group`, `channel`, `cron`, `hook`, `node`).
- Typed protocol frame foundation (`req`/`resp`/`event` classification).
- Gateway RPC parity scaffold for `sessions.list`, `sessions.preview`, `sessions.patch`, `sessions.resolve`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`, `sessions.history`, `sessions.send`, and `session.status`.
- Channel adapter scaffold (`whatsapp`, `telegram`, `slack`, `discord`, generic).

This is intentionally phase 1: it keeps feature coverage by integrating with the
existing Gateway protocol while replacing high-risk runtime and guardrail logic
with Rust.

## Ubuntu 20.04 setup

```bash
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

cd rust-agent
cp openclaw-rs.example.toml openclaw-rs.toml

# Optional: set your token + VT key
export OPENCLAW_RS_GATEWAY_TOKEN="..."
export OPENCLAW_RS_VT_API_KEY="..."

cargo run --release -- --config ./openclaw-rs.toml
```

## Build + service on Ubuntu 20.04

```bash
# Build with pinned toolchain
bash ./scripts/build-ubuntu20.sh

# Install as user service
mkdir -p ~/.config/systemd/user
cp ./deploy/openclaw-agent-rs.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openclaw-agent-rs.service
systemctl --user status openclaw-agent-rs.service
```

## Default runtime behavior

- Connects to `gateway.url`.
- Sends a `connect` frame as `openclaw-agent-rs`.
- Responds to core session RPCs (`sessions.list`, `sessions.preview`, `sessions.patch`, `sessions.resolve`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`, `sessions.history`, `sessions.send`, `session.status`) with typed `resp` frames.
- Supports list filtering knobs on `sessions.list` (`includeGlobal`, `includeUnknown`, `agentId`, `search`) for parity-friendly session queries.
- Responds to gateway introspection RPCs (`health`, `status`) with runtime/session metadata.
- Responds to usage RPCs (`usage.status`, `usage.cost`) with Rust-side aggregate usage/cost placeholder summaries.
- Tracks session metadata (`label`, `spawnedBy`) via `sessions.patch` and uses it for filtered `sessions.resolve` lookups.
- Supports `sessions.usage` range inputs (`startDate`, `endDate`) and optional `includeContextWeight` output hints.
- Inspects incoming Gateway frames for actionable payloads (prompt/command/url/file).
- Applies group activation policy (`mention` or `always`) before evaluation for group contexts.
- Schedules one active request per session with configurable queue behavior (`followup`, `steer`, `collect`).
- Evaluates each action with:
  - prompt injection detector,
  - command risk detector,
  - host integrity monitor,
  - VirusTotal lookups (if configured).
- Emits a `security.decision` event with allow/review/block and reasons.
- Includes session routing hints (`sessionKind`, `chatType`, `wasMentioned`, `replyBack`, `deliveryContext`) in decision events when available.
- Writes blocked actions to `security.quarantine_dir`.

## Config knobs for performance and safety

- `runtime.worker_concurrency`: upper bound for simultaneous evaluations.
- `runtime.max_queue`: bounded work queue.
- `runtime.session_queue_mode`: session queue behavior (`followup`, `steer`, `collect`).
- `runtime.group_activation_mode`: group activation gating (`mention`, `always`).
- `runtime.eval_timeout_ms`: fail-safe timeout per decision.
- `runtime.memory_sample_secs`: periodic RSS logging cadence on Linux.
- `runtime.idempotency_ttl_secs`: duplicate decision cache retention window.
- `runtime.idempotency_max_entries`: cap for idempotency cache footprint.
- `runtime.session_state_path`: JSON state store by default; use `.db/.sqlite/.sqlite3` with `sqlite-state` for SQLite WAL-backed state.
- `security.review_threshold`: minimum risk for "review".
- `security.block_threshold`: minimum risk for "block".
- `security.protect_paths`: files to hash and verify at runtime.
- `security.tool_policies`: per-tool floor action (`allow`, `review`, `block`).
- `security.tool_risk_bonus`: per-tool additive risk scoring.
- `security.channel_risk_bonus`: per-channel additive risk scoring.

## Planned migration phases

1. Keep existing features through protocol compatibility while moving guardrails to Rust.
2. Move core scheduling/session state to Rust.
3. Move high-throughput channel adapters incrementally behind trait-based drivers.
4. Keep protocol schema stable for macOS/iOS/Android/Web clients during migration.

## Replay Harness (sidecar integration)

The replay harness runs the real bridge + defender engine against fixture frames and
asserts emitted `security.decision` output.

```bash
cargo test replay_harness_with_real_defender -- --nocapture
# or:
bash ./scripts/run-replay-harness.sh
```

## Protocol Corpus Snapshot

The protocol corpus test validates typed frame classification and method-family
mapping against versioned fixtures.

```bash
cargo test protocol_corpus_snapshot_matches_expectations -- --nocapture
# or:
bash ./scripts/run-protocol-corpus.sh
```

## Windows GNU toolchain helper (SQLite feature)

When using `x86_64-pc-windows-gnu` with `--features sqlite-state`, run through:

```powershell
.\scripts\with-mingw-env.ps1 "cargo +1.83.0-x86_64-pc-windows-gnu test --features sqlite-state"
.\scripts\with-mingw-env.ps1 "cargo +1.83.0-x86_64-pc-windows-gnu clippy --all-targets --features sqlite-state -- -D warnings"
.\scripts\with-mingw-env.ps1 "cargo +1.83.0-x86_64-pc-windows-gnu build --release --features sqlite-state"
```

## Docker parity smoke

Runs the full Rust validation matrix in Linux (`test`, `clippy`, `release build`,
default + `sqlite-state`):

```bash
bash ./scripts/run-docker-parity-smoke.sh
```

```powershell
.\scripts\run-docker-parity-smoke.ps1
```
