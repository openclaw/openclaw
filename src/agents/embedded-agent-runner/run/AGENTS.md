<!-- Embedded runner test performance notes for limiting full-runner coverage to integration behavior. -->

# Embedded Runner Test Performance

The embedded attempt runner is one of the most expensive agent test surfaces.
Use full-runner tests only when the behavior truly requires the runner.

## Guardrails

- Prefer focused helper tests for prompt assembly, runtime-context construction,
  cache metadata, token accounting, and maintenance decision logic.
- Keep full `runEmbeddedAttempt` coverage for cross-component behavior that
  cannot be proven through helpers, not for a single derived field.
- When extracting a helper from runner logic, make production call that helper
  directly, then test the helper. Avoid test-only copies of runner behavior.
- Preserve context-engine coverage for `sessionKey`, `sessionFile`, token
  budget, current token count, prompt cache, and routing fields when slimming
  tests.
- Treat a standalone full-runner test above a few seconds as suspect. First ask
  whether the proof can move to a production helper plus one cheap integration
  smoke.

## Verification

- For runner test slimming, run the touched helper test and the nearest
  two-file runner/context-engine surface.
- Record Vitest duration, wall time, and RSS when the change is performance
  motivated.

## Runtime Invariants

- Resolve the context engine once per embedded run and reuse it across retries.
  Do not re-resolve inside retry branches.
- Keep user-message persistence ownership in the embedded runner. Retry paths
  must avoid replaying a message that was already persisted.
- Do not mark auth profiles as failed for harness-owned transport timeouts.
  Treat credential evidence and transport lifecycle failures differently.
- Timeout and overflow recovery compaction must stay bounded by safety timeouts
  and run abort signals so compact() cannot stall the run forever.
- Post-compaction retry guards are part of loop safety. Keep arming/observe
  symmetry around compaction-success branches.

## Editing Pitfalls

- Do not add inline abort-listener closures in hot retry-loop branches.
  Prefer extracted helpers for abort wiring and cleanup symmetry.
- Preserve lane and queue behavior when adding recovery branches. Session/global
  enqueue boundaries are intentional and changing them can deadlock.
- Prefer helper extraction for derived state and decision logic, then test those
  helpers directly instead of expanding full runEmbeddedAttempt coverage.

## References

- docs/reference/test.md
- docs/concepts/streaming.md
- src/agents/embedded-agent-runner/run.ts
