---
summary: "Export test evidence and evaluate adaptive CI without changing test execution"
read_when:
  - Investigating test selection or CI cost
  - Exporting Vitest resource-reporter observations
title: "Adaptive CI experiments"
---

# Adaptive CI experiments

Adaptive CI needs file-level execution evidence before it can safely skip tests.
The observation exporter reads existing Vitest resource-reporter logs. It does
not execute tests, change CI routing, or provide evidence for a required check.

## Export observations

For a run that already uses `scripts/lib/vitest-resource-reporter.mts`, capture
its stdout and supply a JSON context file with these fields:

- `repository`: GitHub `owner/repository`.
- `revision` and `tree`: the run's full Git commit and tree IDs.
- `configDigest`, `lockDigest`, and `environmentDigest`: SHA-256 digests of the
  effective test configuration, dependency lock inputs, and execution environment.
  Hash canonical inputs, including runtime, operating system, relevant environment
  settings, and runner configuration. Do not include raw credentials.

```bash
node scripts/ci-test-observations.mjs \
  --log vitest.log \
  --context context.json \
  --dependencies test-dependencies.json \
  --output observations.json
```

`--dependencies` is optional. When supplied, it must be the native Vitest
`experimental.recordDependencies` JSON from the same run and configuration.
The exporter cannot attest that a caller supplied the correct context or cache.
Retain the source run ID and provenance with the exported artifact. Missing or
ambiguous dependency entries stay `null`; they do not mean an empty impact set.
The reporter records the Vitest root so native paths (including UI-local paths)
can be rebased onto repository-relative identities. Global setup dependencies
apply to every file. A cache shared across incompatible runtime or pool
identities is treated as missing.

The export contains repository-relative source identities, counts, outcomes,
durations, and dependencies. It does not copy test titles, errors, or log text.

A passed or failed file is complete only after a terminal run receipt and all
its cases complete without skips or pending cases. Interrupted, filtered,
unhandled-error, and missing-result runs remain unknown. Failure-tail replays
are ignored; conflicting receipts are rejected.

## Current coverage

Resource-reporter users receive the additional versioned inventory and case
counts. This includes existing UI and diagnostic lanes. Ordinary Node shard CI
does not yet enable this reporter or dependency recording. Native Bun-test
execution does not emit Vitest observations. Missing observations must never be
interpreted as passing or irrelevant tests.

Keep rollout in shadow mode until representative full-run audits establish
failure recall, graph completeness, and net savings including collection cost.
