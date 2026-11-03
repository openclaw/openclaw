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

## Observation pilot

Ordinary canonical CI collects the first explicit `unit-fast` Vitest invocation
for each runtime in a job on schedules and on PR runs whose run ID ends in `0`.
Frozen targets and other events retain their existing execution. Runtime
partitioning finishes before the reporter and dependency-recording options are
added. Native Bun tests retain their existing command and are not represented by
Vitest observations. The pilot never skips a test or changes a required check.

Each observed invocation uses a fresh Vite cache directory. This prevents native
dependency records from leaking between configurations or runtimes, but also
changes optimizer and transform-cache identity. Compare complete paired job
times, including this cold-cache cost and artifact upload. `capturePreparationMs`
excludes final serialization and file writing as well as native recording and
cache misses; it is not the complete collection overhead.

The `ci-test-observations-*` artifacts retain sanitized exports for seven days.
Each file is bounded to 8 MiB, with at most one invocation per Vitest runtime per
job. Source metadata includes the workflow run, attempt, job, timestamps and
actual checkout commit/tree. Configuration identity hashes native config
dependencies and effective test settings; environment identity hashes an explicit
allowlist and include-file contents. These are observational identities, not a
claim that every possible environment input is covered. Missing exports and
missing dependencies remain data gaps. Export/upload failures do not replace the
test result, and raw test logs and assertion text are not uploaded by this pilot.

At Vitest's run-start callback, before global setup and test execution, the
capture writes an incomplete export to the same `observations.json` path. Its
`preExecution` field contains `recordedAt` and a sanitized observation snapshot:
the checkout/configuration identity and invocation inventory, with unknown
outcomes and no dependencies. Completion replaces the export atomically with
final outcomes and dependencies, retaining the original `preExecution` snapshot
and context. Changes to configuration or include files during execution cannot
rewrite that frozen identity. A missing or invalid terminal receipt leaves the
incomplete snapshot available if the artifact upload runs.

This snapshot follows configuration evaluation and native test selection. It
does not contain a prior graph, source diff, model ranking or selection decision.
Global setup can still change worker settings after capture. The local recording
timestamp is not artifact availability: a later consumer must also retain the
publication/download time before using an earlier run as predictive evidence.

The first readout compares usable-data coverage, native-Bun gaps, observed
failures, fallback causes, and paired total job costs. Learned selection and
automatic omission require a separate evaluation and rollout decision.

A passed or failed file is complete only after a terminal run receipt and all
its cases complete without skips or pending cases. Interrupted, filtered,
unhandled-error, and missing-result runs remain unknown. Failure-tail replays
are ignored; conflicting receipts are rejected.

## Current coverage

Resource-reporter users receive the additional versioned inventory and case
counts. This includes existing UI and diagnostic lanes. Ordinary Node shard CI
enables collection only for the sampled `unit-fast` invocations described above.
Other configs and native Bun-test execution do not emit these pilot exports.
Missing observations must never be interpreted as passing or irrelevant tests.

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
