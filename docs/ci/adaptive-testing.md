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

If expanded dependency paths exceed the export limit, the capture first uses a
version-2 observation payload: one shared `dependencyPaths` table with integer
references in each file's `dependencies` array. Readers resolve those references
before graph selection or model scoring; missing edges remain `null`. Small
exports and frozen pre-execution snapshots keep version 1. Both versions remain
readable, including retained historical artifacts. The outer export stays version 1.
If the compact payload still exceeds the limit, the capture retains
terminal outcomes and the frozen snapshot with all dependencies set to `null`,
and emits a warning. Missing graph data still requires conservative selection.
If that smaller export also exceeds the limit, the incomplete snapshot remains.

Before launching each observed Vitest child, the shard wrapper also writes
`launch.json`. It records the actual checkout commit/tree and whether tracked or
untracked changes exist, the preflight comparison base commit/tree, and a
rename/deletion-aware diff. The comparison base is not necessarily the source of
a prior dependency graph; consumers must retain both identities independently.
Recording does not fetch Git history; an unavailable comparison commit is a data gap.
The file hashes the finalized command arguments and pre/post-shard include-file
contents without exporting absolute paths. A missing base, dirty checkout, or
unreadable input records a fallback reason. Every launch record includes
`no-prior-snapshot`: prior qualification happens later, when the reporter has
the native inventory. The launch record itself does not resolve priors.

The reporter freezes the launch file's SHA-256 hash when it initializes and
retains it as `preExecution.launchInputs`. Consumers must match the hash to the
same directory's uploaded `launch.json`, verify source/runtime identity, and
check that recording preceded reporter initialization. A missing or mismatched
record is a data gap. Both files use the existing sampled artifact upload;
launch-only artifacts can survive a child that exits before producing inventory.
Launch records are bounded to 1 MiB. Preparation is best effort and does not
change the test command or result when it fails.

The native snapshot follows configuration evaluation and native test selection;
the launch record precedes them. Its `decision` field freezes a graph proposal
before tests execute, using the full native inventory. `scheduledFiles` always
contains that inventory; the proposal cannot change execution.
Global setup can still change worker settings after capture. The local recording
timestamp is not artifact availability: a later consumer must also retain the
publication/download time before using an earlier run as predictive evidence.

For the canonical `unit-fast` configuration, `preExecution.graphInputs` records
a version-1 profile with separate configuration and environment hashes. These
omit resolved include membership and pre/post-shard include-file contents. They
retain native configuration sources, direct setup sources, declared execution
and transform settings, runtime identity, and an explicit environment allowlist.
Repository paths in settings are normalized before hashing; regular expressions
retain their pattern and flags. Unsupported profiles or nonserializable settings
produce `null` without discarding the exact-run observations.

These hashes allow comparison of declared graph inputs across different file
selections. They do not establish interchangeable graphs or outcomes: `unit-fast`
shares process state between files, and the captured environment and direct setup
sources are not an exhaustive dependency contract. Consumers must also compare
the repository, lock, project/pool, runtime, platform and dependency-root identity,
retain source/diff provenance, and measure overlapping-file graph differences.
The shadow selector still requires the original exact context. Matching graph
inputs never grants permission to omit tests.

### Published prior snapshots

For sampled same-repository PRs and scheduled runs, preflight uses its existing
read-only Actions permission to restore at most two observation archives from
the five most recent completed scheduled main runs. Successful and failed
workflows can contribute observations; cancelled runs cannot. An unrelated job
failure does not erase complete file results, while missing, incomplete or
failing file history still requires conservative selection. Restore verifies the exact
run/attempt, source commit/tree, archive digest and paired launch/member hashes.
The producer must have completed and published before the current run began.
Restore has a shared ten-second deadline and does not retry requests. Missing
history or unavailable APIs produce an empty bundle and preserve full execution.

The bundle is shared through a same-run artifact. Test jobs download it without
additional token permissions. Each bundle binds the current workflow run,
attempt and actual checkout commit/tree; the reporter also freezes the bundle
hash. Preflight obtains the exact prior-to-current comparison from GitHub once
per prior revision, including removed paths and both ends of renames. It verifies
the prior is an ancestor. When GitHub's comparison reaches its 300-file cap,
preflight compares one recursive prior tree with the checked-out current tree.
The tree response must be complete and fit within 32 MiB; comparisons with 600 or
more changed paths remain ineligible. This uses the same ten-second restore
deadline and includes removed paths, rename endpoints, and file-mode changes.
The native inventory callback consumes this
bound comparison; it does not substitute the launch record's comparison base.

Exact configuration, lock, environment and runtime identities must match. The
test checkout can remain shallow; no test process fetches history or calls GitHub.
Unknown source, dirty checkout, stale bundle or incompatible inputs
produce an explicit fallback. Different shard membership can still prevent a
match; graph-input comparability alone does not relax the selector.

The frozen decision records prior provenance, changed paths, graph candidates
and the unchanged scheduled inventory.
These are prospective proposals, not measured omission savings. Include restore,
download, comparison and export costs in the eventual net-benefit calculation.

### Owned model rankings

When a compatible prior is available, the same inventory callback records raw
CART scores in `decision.ranking`. The source-controlled model in
`scripts/ci-adaptive-model.json` uses five structural features: basename match,
path-token overlap, same directory, observed dependency membership and the
logarithm of changed-path count. Recorded dependencies describe membership,
not direct edges or graph distance. Current outcomes and durations never enter
these features. Missing dependency evidence remains unknown for a model that
uses it; invalid or unavailable models produce null scores with reasons.

The record includes hashes of the actual model bytes, extractor source and
scoring inputs, along with elapsed scoring time. Rows preserve the full native
inventory and its order, including project and pool identity. There is no score
threshold, network request, provider token use or change to test execution.

The initial tiny tree was trained on 120 rows from controlled source mutations,
with separate owner groups reserved for evaluation. Its manifest records the
corpus and row hashes. The 64-row held-out result had ranking AUC 0.98276, but
its predictions coincided with dependency membership on that narrow corpus.
These class-balanced leaf scores are not calibrated failure probabilities or
evidence of improved selection over the graph. Natural regression coverage and
net CI savings still require full-run comparisons.

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

Keep historical graph and learned selection in shadow mode until representative full-run audits establish
failure recall, graph completeness, and net savings including collection cost.

### Qualified Markdown skipping pilot

Canonical pull requests in aggressive selection mode can omit nine qualified
Markdown tests from the conventional directory fallback. This applies only when
the change includes a Markdown source module and otherwise contains only test
budget allocations, regular JavaScript/TypeScript production sources under
`src`, `extensions` or `packages`, or companion tests with a verified separate CI process.
Companion tests must have one explicit, complete canonical owner outside the
shared Markdown worker. Same-worker tests, unknown owners, helpers, fixtures,
missing or symlinked companion sources, and tooling/configuration changes retain
full coverage. A changed production companion that affects a qualified test's
input fingerprint retains that test. Independently checked docs
keep their existing selection rules. Explicit owners, changed tests,
import consumers, policy checks and smoke tests retain their existing selection.
The stateful table test is outside this pilot. Scheduled, main and release runs
retain their existing full coverage.

Ten pure Markdown test files run in the dedicated `core-markdown` owner. It
shares Node worker policy, hermetic environment setup, output redaction and
resource controls with other lanes, without their application transforms or
custom cleanup runner. The table test keeps its existing unit owner. New tests
keep the ordinary ownership rules until explicitly moved into this lane.

`config/ci-adaptive-markdown.json` records reviewed input fingerprints. The
selector uses its existing import graph to hash each test's current transitive
workspace inputs, plus the shared test configuration and dependency lock inputs.
Missing, changed or symlinked inputs retain the test. A new import changes the
importing module's fingerprint; an unqualified test is never omitted. This is
unchanged-input reuse, not a learned prediction or historical graph fallback.

The PR summary lists actual omissions after all selection rules are combined.
Set repository variable `OPENCLAW_CI_NODE_SELECTION=full` to disable the pilot
along with aggressive selection. Refresh fingerprints only after reviewing the
changed input closure and repeating full-versus-selected Node/Bun proof, including
an injected regression. A successful provider call does not qualify a test.

The Markdown worker reads Node execution flags independently of the test watchdog
and its other-lane inventories. Updating an unrelated lane's test list does not
invalidate Markdown qualification. Changes to the Node flag policy still do.

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

## Evaluate recorded decisions

Compare an exported capture's frozen graph and model scores with its later
outcomes:

```bash
node scripts/ci-adaptive-evaluate.mjs \
  --input observations.json \
  --output evaluation.json
```

This command performs no inference or test execution. It joins files by their
project, pool and path, including when ranking rows have a different order.
Missing predictions remain unavailable, and incomplete files remain unknown.
The report identifies failed files proposed for omission, recorded score
buckets and summed complete-file durations. Failures remain unattributed;
they are not automatically causal regression labels or independent episodes.

The evaluator rejects inconsistent source/inventory identities and recording
times. The caller must independently verify source and prior artifact
provenance. Summed file durations are not elapsed time, CPU time or savings.

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

## Declared file inputs

Prefer module imports for JSON fixtures so Vitest records their dependencies
without additional rules. Binary fixtures read through `node:fs` use the exact
test-to-input mapping in `test/vitest/vitest.declared-inputs.ts`. The shared Vite
plugin registers these inputs with native dependency recording and related-test
selection. It does not intercept file reads or change the scheduled inventory.
Undeclared file reads remain a graph coverage gap.

## Optional Jev ranking experiment

`node scripts/ci-adaptive-jev.mjs --request selection-request.json --output jev-ranking.json`
accepts the existing selector request fields `version`, `context`, `files`, and
`changedFiles`. Supply `TYPESAFE_API_KEY` only to this trusted command. Without
it, the command writes null scores and keeps every scheduled file without making
a request. Ordinary CI does not invoke this command or receive this credential.

With a key, the command sends only changed paths and test identities to the
[TypeSafe System One endpoint](https://docs.typesafe.ai/api/system-one), using
the pinned `jev-1.14.0` model. It does not send source, outcomes, logs, environment
values or conversation history. Each batch contains at most 25 opaque question
IDs; requests and streamed responses are limited to 64 KiB, with a single
ten-second deadline and no retries or redirects. At most 1,000 tests and 600
changed paths are accepted. Invalid or incomplete responses discard all scores
and preserve the full inventory.

These are path-only experimental scores, not calibrated regression probabilities.
The artifact records its actual inference time, input hash and reported token
usage. A failed request can leave total usage unknown; `usage.complete` makes
that explicit. Keep this artifact separate from frozen pre-execution decisions:
a later replay must never be presented as a prospective prediction. Live model
quality and billing need a key-backed experiment before any scheduling decision.
