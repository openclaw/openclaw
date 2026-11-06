# Crabbox idle state polling acceptance

Preregister this rule in the LIVESTATE PR before the first execution. This file
defines a synthetic workload, not a measured result.

The flow is an isolated real Gateway with the bundled Crabbox provider enabled,
one synthetic profile, no sessions, no workers, no warm images, and no legacy
leases. Reserve capacity is zero. A local executable answers only `--version`;
every other invocation fails and invalidates the run. No provider credentials,
network service, or machine allocation is needed. A loopback `/healthz` request
establishes Gateway readiness without issuing an agent turn.

The Gateway has two 60-second reconciliation callers: the environment service
and placement recovery. Their maintenance calls may coalesce. After readiness,
allow 70 seconds for both timers to run, then observe one 120-second steady
window. Keep the preceding `boot` and following `shutdown` phases separate from
`steady`. A successful version probe proves that provider maintenance ran;
the frozen observer must independently establish the SQL attribution.

## Metrics and acceptance

- Count SQL statements, worker requests, and runtime MAIN statements in each
  phase with the frozen v3.1.4 observer and its unchanged companion files. Report
  the scoped `plugin_state_entries` count query separately, per minute.
- Establish the baseline before accepting the premise: at least one steady
  legacy-lease count query must be attributable to Crabbox maintenance. If the
  pattern does not reproduce, stop this item and report the gap.
- For retaining successful migration admission at its owner, the candidate must
  perform zero steady legacy-lease count queries; its boot admission check remains.
  Total steady SQL and worker requests must not increase; runtime MAIN remains
  zero. Report actual coalescing rather than assuming exactly two counts/minute.
- Run three alternating baseline/candidate pairs on the same platform when the
  campaign host admission permits; otherwise run one pair and state the reduced
  confidence. Each run uses fresh synthetic state. Report count medians and
  min–max separately for boot and steady. This workload makes no latency, CPU-time,
  or memory improvement claim. Optional per-thread CPU profiles support attribution.

Use the campaign proof slot for heavy execution and record load/free-space
admission outside this script. Build the exact head first; never use an old
`dist` tree to claim current-source behavior. The invocation owns placing all
output and temporary state on the approved internal disk and verifying the
frozen observer hashes.

```sh
node --import ./scripts/tsx.mjs scripts/perf/crabbox-state-polling.mts \
  --out "$PROOF_ROOT/crabbox-base-1" \
  --entry dist/entry.js \
  --observer "$SQL_OBSERVER"
```

Add `--profile` for per-thread `node --cpu-prof` artifacts. The output directory
must be new and its parent must exist. It holds isolated HOME, config, state,
temporary files, logs, phase markers, observer ledgers, invocation counts, and
`evidence.json` with readiness, failure, and clean-shutdown evidence. Shared
reports contain only normalized counts, shapes, and source attribution.

Any future timing claim needs a separate preregistered comparison: at least five
samples per head in alternating order, cold and warm results separated, median,
p95 and spread, the campaign timing lock, and one-minute load below 24. Every
user-facing metric must hold or improve; a 20% worse cell stops acceptance.
