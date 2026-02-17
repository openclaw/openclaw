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
- Inspects incoming Gateway frames for actionable payloads (prompt/command/url/file).
- Evaluates each action with:
  - prompt injection detector,
  - command risk detector,
  - host integrity monitor,
  - VirusTotal lookups (if configured).
- Emits a `security.decision` event with allow/review/block and reasons.
- Writes blocked actions to `security.quarantine_dir`.

## Config knobs for performance and safety

- `runtime.worker_concurrency`: upper bound for simultaneous evaluations.
- `runtime.max_queue`: bounded work queue.
- `runtime.eval_timeout_ms`: fail-safe timeout per decision.
- `runtime.memory_sample_secs`: periodic RSS logging cadence on Linux.
- `security.review_threshold`: minimum risk for "review".
- `security.block_threshold`: minimum risk for "block".
- `security.protect_paths`: files to hash and verify at runtime.

## Planned migration phases

1. Keep existing features through protocol compatibility while moving guardrails to Rust.
2. Move core scheduling/session state to Rust.
3. Move high-throughput channel adapters incrementally behind trait-based drivers.
4. Keep protocol schema stable for macOS/iOS/Android/Web clients during migration.
