# Claw-Loop vNext (Bridge -> SDK-first)

This directory contains the incremental vNext implementation that preserves the original claw-loop contract while reducing tmux flakiness.

## Contract

1. Propose phases
2. User reviews/edits phases
3. Execute after approval
4. Track until complete/blocked

## Rollout

1. Bridge mode (`orchestration.mode=bridge`): SDK-first delivery with tmux fallback.
2. SDK-first mode (`orchestration.mode=sdk-first`): SDK primary path and tmux fallback only on delivery failure.
3. SDK-only mode (future): remove tmux fallback path after confidence window.

## Demo (dry run)

```bash
node --import tsx scripts/claw-loop-vnext-dry-run.ts
```

What it demonstrates:

- ACK loss on primary transport triggers retry
- fallback delivery succeeds
- duplicate `PHASE_COMPLETE` does not double-advance
- stuck detector sends a single nudge and rate-limits repeats

## Tests

```bash
pnpm exec vitest run \
  src/claw-loop-vnext/__tests__/goal.test.ts \
  src/claw-loop-vnext/__tests__/signal-parser.test.ts \
  src/claw-loop-vnext/__tests__/runtime-store.test.ts \
  src/claw-loop-vnext/__tests__/send-with-retry.test.ts \
  src/claw-loop-vnext/__tests__/orchestrator.dedupe.test.ts \
  src/claw-loop-vnext/__tests__/regression-unknown-delivery.test.ts \
  src/claw-loop-vnext/__tests__/integration-mocked-driver.test.ts \
  src/claw-loop-vnext/__tests__/regression-stuck-single-nudge.test.ts
```

## Known Limitations

- SDK transport currently uses `codex exec --json` as the ACK source; it is a pragmatic bridge, not a dedicated embedded SDK session yet.
- Runtime store is JSON-backed (not SQLite) in this slice.
- `check` currently provides listing/status behavior; full autonomous heartbeat/tick scheduling is partially implemented via `nudgeIfStuck` and will be expanded.
