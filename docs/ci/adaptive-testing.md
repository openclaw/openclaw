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

## Plan in shadow mode

The selector consumes an observation export and an explicit current inventory.
It writes a candidate plan; `scheduledFiles` always contains the full inventory.
Nothing in CI consumes the candidate as permission to skip tests.

```bash
node scripts/ci-adaptive-select.mjs \
  --observations observations.json \
  --request selection-request.json \
  --output shadow-plan.json
```

The request is a version-1 JSON object:

| Field                              | Meaning                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `context`                          | Current source and configuration, with the same fields as the export context.       |
| `baselineRevision`, `baselineTree` | Exact source used as the base of `changedFiles`; must match the observation export. |
| `files`                            | Complete current inventory of `{file, project, pool}` objects. Include new tests.   |
| `changedFiles`                     | Repository-relative changed paths, including deletions and both sides of renames.   |
| `audit`                            | Required boolean. `true` selects the full inventory for an audit.                   |
| `alwaysRun`                        | Optional array of mandatory test file paths.                                        |

Configuration mismatch, a wrong diff base, global test infrastructure changes,
and unmapped changed paths select everything. New tests, incomplete evidence,
previous failures, and missing dependencies keep the affected test selected.
Every candidate carries its reasons. File counts are not runtime savings.

An optional `--recommendations recommendations.json` accepts
`{version: 1, context, selectedFiles: [{file, project, pool}]}`. Its context must
match the current source and configuration. Recommendations only add tests;
an empty or negative model recommendation cannot remove graph-selected tests.
This allows a local tree model or hosted decision model to share the same
experiment interface without making model predictions authoritative.

The caller owns inventory completeness, diff construction, provenance, and any
external model invocation. The command does not call a model or send source to a
service. Historical graphs cannot prove dynamic filesystem or generated-input
coverage; full-run comparison remains necessary before enabling actual skips.

## Estimate cost and compute savings

```bash
node scripts/ci-adaptive-costs.mjs \
  --input scenario.json \
  --output cost-report.json \
  --markdown cost-report.md
```

Supply a version-1 scenario with `mode: "shadow"` or `mode: "projection"`, a
`jobs` array, and `modelUsage`. Every job represents one actual execution attempt;
include retries with distinct IDs. Measure the baseline and state projected
inputs explicitly. A job has these fields:

| Field                   | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `id`                    | Unique execution attempt identity.                                          |
| `baselineSeconds`       | Measured whole-job allocation duration.                                     |
| `selectableSeconds`     | Portion of that duration affected by test selection.                        |
| `retainedFraction`      | Estimated fraction of selectable _time_ retained, from 0 to 1.              |
| `auditRate`             | Fraction of executions that run all tests, from 0 to 1.                     |
| `overheadSeconds`       | Added collection, planning, and scoring wait per job.                       |
| `auditOverheadSeconds`  | Extra setup/work on full-run audits.                                        |
| `dropEmptyJob`          | Whether a zero-test selection can eliminate fixed job setup.                |
| `usdPerMinute`          | Dated price for this provider, platform and runner size; `null` if unknown. |
| `billingQuantumSeconds` | Actual billing rounding unit when the rate is known.                        |
| `allocatedVcpus`        | Known allocated CPU count, or `null`; not CPU utilization.                  |

The model retains fixed setup, adds overhead, and prices selected and full-audit
executions separately before averaging. It assumes the selected-work fraction
scales that job's selectable allocation time; validate this with real paired
runs. File-count reduction alone is not enough. Shadow mode retains all test
work and only adds collection/scoring overhead.

`modelUsage.baseline` and `modelUsage.candidate` each contain `inputTokens`,
`outputTokens`, `inputUsdPerMillion`, and `outputUsdPerMillion`. Include all
requests and retries. Missing usage or prices stay unknown; use explicit zeros
for a measured no-model baseline. Ordinary unit tests consume no model tokens,
so introducing hosted selection increases tokens. Token savings require an
explicit metered baseline, such as replaced scoring requests or live-model tests.

Outputs distinguish runner seconds, allocated vCPU-minutes, runner list cost,
model tokens, and model list cost. Negative savings are retained. Prices are
scenario inputs, not invoice predictions; credits, discounts, minimums and
storage charges need separate accounting. Workflow critical-path savings stay
unknown until a dependency timeline is available. Do not label summed job time
as developer wait time.
