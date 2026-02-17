# Rust Rewrite Plan (Feature-Parity First)

## Goal alignment

1. Ubuntu 20.04 production runtime in Rust.
2. Better memory behavior and predictable throughput.
3. Defender layer against prompt injection, unsafe commands, and tampered host/runtime state.

## Phase strategy

### Phase 1 (implemented in this directory)

- Rust runtime process + Gateway WebSocket compatibility.
- Typed protocol frame foundation (`req`/`resp`/`event`) and method-family classification.
- Gateway known-method registry scaffold for RPC dispatch parity.
- Rust defender policy engine with bounded worker concurrency.
- Prompt injection scoring + command risk scoring.
- Host integrity baseline checks.
- VirusTotal signal integration for URL/file indicators.
- Quarantine ledger for blocked actions.

### Phase 2 (in progress)

- Move session scheduler and idempotency dedupe cache to Rust.
- Implemented first-pass session FIFO scheduler (one active request per session, bounded pending queue).
- Implemented first pass idempotency dedupe cache with TTL + bounded entries.
- Implemented dual-backend session state tracking:
  - JSON (default)
  - SQLite WAL backend behind `sqlite-state` feature (auto-selected for `.db/.sqlite/.sqlite3` paths)
- Introduce a compact internal event model (`bytes` + pooled buffers).
- Keep advanced routing parity (group isolation/activation policies/reply-back) in progress.

### Phase 3 (in progress)

- Migrate core channel adapters incrementally behind trait drivers.
- Added trait-based channel adapter scaffold (`whatsapp`, `telegram`, `slack`, `discord`, generic fallback) with capability descriptors.
- Keep protocol schema stable for existing clients (macOS/iOS/Android/Web/CLI).

### Phase 4 (next)

- Decommission TypeScript runtime path after parity tests pass.

## Performance design choices

- Bounded concurrent evaluations via semaphore.
- Bounded queue target in config.
- Lightweight Linux RSS sampler for runtime memory observability.
- Timeout for each security evaluation to prevent backlog growth.
- Optional external Intel (VirusTotal) behind short timeout.
- Quarantine writes are append-only JSON files for low contention and post-incident forensics.

## Security design choices

- Risk-based decision model (`allow`, `review`, `block`).
- Pattern and behavior based prompt-injection detection.
- Command policy with explicit deny patterns and allow-prefix policy.
- Runtime file hash checks to detect tampering.
- Audit-only mode for safe rollout before hard block enforcement.
