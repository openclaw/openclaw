# Rust Rewrite Plan (Feature-Parity First)

## Goal alignment

1. Ubuntu 20.04 production runtime in Rust.
2. Better memory behavior and predictable throughput.
3. Defender layer against prompt injection, unsafe commands, and tampered host/runtime state.

## Phase strategy

### Phase 1 (implemented in this directory)

- Rust runtime process + Gateway WebSocket compatibility.
- Rust defender policy engine with bounded worker concurrency.
- Prompt injection scoring + command risk scoring.
- Host integrity baseline checks.
- VirusTotal signal integration for URL/file indicators.
- Quarantine ledger for blocked actions.

### Phase 2 (next)

- Move session scheduler and idempotency dedupe cache to Rust.
- Introduce a compact internal event model (`bytes` + pooled buffers).
- Persist runtime state in SQLite with WAL mode.

### Phase 3 (next)

- Migrate core channel adapters incrementally behind trait drivers.
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
