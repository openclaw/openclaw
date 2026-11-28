---
summary: "Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Check"
read_when:
  - You are dispatching CI or Full Release Validation by hand
  - You need the Windows Testbox Check inputs
title: "Manual dispatches"
sidebarTitle: "Manual dispatches"
doc-schema-version: 1
---

Manual CI and Windows proof reference. Part of [CI scope and routing](/ci/scope-and-routing).

## Manual dispatches

Ordinary manual CI uses the normal graph, forcing all non-Android scoped lanes: Linux Node, bundled-plugin, plugin/channel contract shards, Node 24 minimum compatibility, `check-*`, `check-additional-*`, built-artifact smoke, docs, Python skills, Windows, macOS, full iOS build/test/screenshots, and Control UI/native app i18n. Logical runner profile: always `github`, regardless of physical `runs-on` fallback. Node 24 minimum compatibility runs only in manual CI and Full Release Validation, not push/PR CI.

| Scope                              | Behavior                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android                            | Manual: `include_android=true` or `release_gate`. Full-scope validation passes `include_android=true`, not `release_gate`; npm qualification defers Android.                                                                                                                                                                                             |
| Exact-head `release_gate`          | Keeps PR macOS, iOS smoke, and generated-native-locale scope; excludes iOS screenshots/native tests, Docker seed, and QA Smoke.                                                                                                                                                                                                                          |
| Automatic source PRs/release gates | Check native extraction inventory and Android/Apple localization safety without requiring translated/platform-generated output in the same PR.                                                                                                                                                                                                           |
| Native App Locale Refresh          | Serialized workflow rebuilds artifacts in one isolated PR; exact-head auto-merge after required checks.                                                                                                                                                                                                                                                  |
| Native parity                      | Blocking for generated-artifact PRs, generated-scope release gates, ordinary manual CI, full-scope validation, and release prep. Proven obsolete translation IDs, Android generated rows, and Apple catalog rows warn while refresh catches up; active-key coverage, correctness, and other parity remain blocking. See [local checks](/ci/local-proof). |
| Control UI locale parity           | Advisory on automatic PR/`main`; blocking on manual/release CI.                                                                                                                                                                                                                                                                                          |
| Excluded from CI                   | Plugin prerelease static checks, full `agentic-plugins` and extension batch sweeps, plugin prerelease Docker lanes. Docker prerelease runs only through `Full Release Validation`’s separate `Plugin Prerelease` dispatch with release-validation gate enabled.                                                                                          |

- PR ratchets compare the checked-out synthetic merge tree and verify its head parent against the event head. Max-lines chains the environment-variable budget with the same fork-point ref before assertion-safety, catching production growth before `main`.
- Manual runs have unique concurrency groups, preventing push/PR cancellation of candidate suites. Trusted callers can set `target_ref` to a branch, tag, or full SHA; workflow comes from the dispatch ref. Ratchets use the target/default-branch-head merge base resolved for that run.
- Maintainer fallback for capacity-stalled PR CI: `release_gate` requires full-SHA `target_ref` matching the dispatched branch head and `pull_request_number` identifying the open PR whose merge tree is validated. Merge-tree lint uses hosted PR CI’s five core stripes plus one extension stripe, splitting type-aware lint across runners.
- Ordinary upstream manual CI builds the full package, retaining QA Smoke’s full profile and Control UI performance without owner-path filtering. `docker-seed-e2e-contract-v1` targets select `published-upgrade-survivor`: the exact `legacy-operator-state` + `auto-auth` proof used by every admitted upstream main run. Older targets without the tier selector retain the survivor.
- `resolveDockerSeedLanes` adds `cron-mcp-cleanup`, `mcp-channels`, `mcp-code-mode-gateway`, and `update-channel-switch` to every ordinary manual dispatch, including `npm-beta`/`npm-stable` qualification. Main-only `ciArtifacts` preparation also applies to admitted main-shape qualification dispatches for main-job timing comparisons. PRs omit Docker seed/QA Smoke. Full Release Validation uses its normal CI child without `release_gate`; frozen-target capability checks remain.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
VALIDATION_SHA="<full-commit-sha>"
gh workflow run full-release-validation.yml --ref main \
  -f trusted_workflow_json='{"trustedWorkflow":null,"validationPurpose":"diagnostic","publicationSelection":null}' \
  -f ref="$VALIDATION_SHA" \
  -f expected_sha="$VALIDATION_SHA"
```

Gateway extended-stable shared publication requires complete candidate-owned Full Release Validation from an independently admitted `release-ci/*` harness: Q=C by default, or explicit reviewed main-ancestor Q, targeting frozen `extended-stable/YYYY.M.33`. Use the [admitted helper](/reference/full-release-validation/dispatch); moving-main fallbacks, direct `main` producers, and the diagnostic example above do not qualify. Current manifests also supply qualified npm preflight artifacts.

`OpenClaw Release Publish` dispatches from protected lightweight `release-publish/<sha12>-<epoch>` at frozen trusted-main Tooling SHA. With `npm_dist_tag=extended-stable`, it publishes official npm plugins/core, attaches evidence, publishes Docker, and finalizes a non-Latest GitHub Release. Only `extended-stable*` container aliases advance; ClawHub, native-app, website, regular npm `latest`, and private dist-tags are excluded. Core-resume verifies registry bytes before evidence/finalization; Docker-only recovery leaves GitHub finalization untouched. [Commands and recovery](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/extended-stable-publish.md).

<a id="windows-testbox-probe" />

### Windows Testbox Check

`windows-testbox-probe.yml` keeps Windows/WSL checking and headless CI on `runner_label`. `run_windows_ci` defaults to `false`; without an installed package binding, `true` requests independent headless CI and native Scheduled Task proof jobs (native: GitHub-hosted `windows-2025`). Either requested proof failing fails the workflow.

- Source-native preparation: compile/validate workers in a separate five-minute step; reuse through content-validated worker cache. Failure blocks lifecycle. Lifecycle retains five minutes including cache validation/finalization, 240-second case, 65-second restart observation, unchanged assertions/cleanup; total job limit 75 minutes.
- `skip_defender_exclusions=true` leaves Defender unchanged everywhere, including native/installed Scheduled Task jobs. Only workspace/Node process exclusions are skipped; proof selection, isolation checks, lifecycle tests, cleanup, and evidence upload remain. Default `false`: best-effort exclusions for Windows CI/exact replay.
- Both proofs require exact 40-character commit SHA `target_ref`; both check it out, native verifies equality. Native preflight precedes setup and requires an interactive Windows session; noninteractive runners fail, never skip. `windows-2025` alone is not qualification: actual-runner lifecycle assertions/cleanup must pass. Cleanup/diagnostic upload run after failure; retained evidence is removed only after both succeed.

#### Installed Scheduled Task upgrades

Set `run_windows_ci=true`, one successful Package Acceptance `installed_startup_package` binding, `runner_label=windows-2025`, `keepalive_minutes=0`; other proof modes off. Dispatch the reviewed workflow revision and use its exact SHA as `target_ref`; the binding independently pins product. Empty binding retains independent source-only CI/native jobs.

The existing resolver authenticates candidate and passes a verified same-run artifact to native proof (`contents: read`). Three cells: fresh installed candidate, then unchanged published 2026.9.3 and 2026.9.4 CLI updaters against candidate. Each upgrade preserves a running peer profile under its standard Task name. Live status must match verified version/build ID; updated Gateway gets a new PID, peer retains PID/baseline identity.

Candidate update preview/deep Doctor inspect registered Task actions: disabled custom-named Gateway CMD task reported as extra; owned disabled task missing its launcher. Fresh cell also inspects a disabled direct executable action: packaged preview must leave unsupported automatic service management unavailable. This proves read-only inspection/preservation, not direct-action execution/update mutation.

Cells prepare normal npm installs sequentially. Actual Task/descendant cleanup and immutable proof upload must succeed before retiring disposable prefixes/caches or starting another cell. Failure retains evidence/stops; forced command cleanup cannot prove natural exit. Final artifact requires all three cells.

After tooling setup, actual free space is checked against provisional allowances: 13 GiB fresh-install, 29 GiB published-pair—not measured package bounds/runner capacity. Space/owned allocations are recorded at lifecycle boundaries; intervening peaks unknown. Command/test/step/job deadlines unchanged.

#### Exact Windows test replay

For ordered diagnosis of a recorded CI failure, `windows_ci_replay` accepts a JSON object:

| Field            | Required value                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `nodeVersion`    | Exact Node 24 patch                                                                                  |
| `packageManager` | Checkout’s complete pnpm integrity pin                                                               |
| `vitestVersion`  | Checkout’s Vitest version                                                                            |
| `maxWorkers`     | Integer 1–4                                                                                          |
| `files`          | Original ordered array of literal tracked paths under `src/`, `test/`, `extensions/`, or `packages/` |
| `projects`       | Original ordered array of `test/vitest/vitest.<name>.config.ts` paths                                |

No globs, shell text, arbitrary CLI arguments, or environment overrides. Set exact source SHA `target_ref`, original `runner_label`, `keepalive_minutes=0`; other proof modes off. Runs only existing `scripts/test-projects.mts` with `--fileParallelism`, one project process at a time, requested workers, original Windows CI heap/extension-shard settings. Normal CI worker policy unchanged; frozen-source dispatcher owns preparation/lifetime, never copied current tooling.

Run baseline/failing sources separately and serially at the same reviewed workflow revision, each with its own checkout/frozen install; never switch active-checkout sources. Record both runs’ actual CPU/RAM, not label-inferred capacity.

`windows-ci-replay-<runId>-<attempt>` retains input, source/workflow identities, dependency hashes, native runtime/resources, exact argv, combined output, process status, observed project order, and retained-namespace diagnostics. Success requires the complete expected project sequence; earlier failure retains partial sequence and stays failed. No retries or pass/fail waivers.

No persistent Testbox lease, SSH, or keepalive. Existing test owner handles lifetime; Actions owns final job/runner teardown. Unverified descendant settlement can retain temporary namespaces: do not delete during runs or infer settlement from zero status. Preserve diagnostics, inspect final runner cleanup, and report missing teardown evidence separately from test result.

#### Installed repair-worker compatibility and cleanup

Set `installed_repair_worker=true`, one `installed_startup_package` binding, `runner_label=windows-2025`, `keepalive_minutes=0`, exact reviewed workflow commit as `target_ref`; other proof modes off. Existing package owner installs/verifies candidate. Native admission requires fresh hosted runner without credentials, operator mounts, Tailnet, or managed identity.

Authenticate/install npm 2026.9.4/2026.9.5; their unchanged published repair controllers call installed candidate worker: 2026.9.4 delegates verifying; 2026.9.5 also validation. Both must receive deferred unavailable without provider requests, validation calls, or synthetic-state changes. This is controller compatibility, not complete installed-updater upgrade.

Separate cells use packaged executor/ledger owners to admit real delegated work against loopback model fixture and reject wrong receiver. A real tool starts descendants; normal/forced worker exits must remove them before parent settlement while outer observer/Windows Job launcher stay alive. Parent/outer cleanup cannot satisfy proof. Fixed deadlines: worker 90 seconds, turn 60, cell 120, extinction two.

`windows-installed-startup-<runId>-<attempt>` retains `repair-results.json`, failed/completed cells, native Job observations, PID/start identities, exact package/controller/runtime/tooling hashes, synthetic provider counts, state effects, final cleanup. Stop after failed cell; runner teardown never substitutes for worker qualification.

#### Installed Gateway startup measurements

Measure one immutable npm package on selected Windows runner: full tooling commit `target_ref`, `run_windows_ci=false`, `keepalive_minutes=0`, exact `startup_node_version` (default `26.9.0`); WSL/Defender defaults. Optional `installed_startup_package`: JSON fields `runId`, `runAttempt`, `workflowSha`, `artifactId`, `artifactDigest`, `packageSha256`, `sourceSha`. Use successful Package Acceptance’s immutable `package-under-test-<runId>-<runAttempt>`. Workflow verifies producer/artifact metadata, resolves through package-candidate owner, installs/rebuilds with normal npm lifecycle scripts.

After Windows lifecycle fixtures pass, installed `openclaw.mjs` runs once with new synthetic state, then eight times reusing it. Each records HTTP readiness, first status/health RPC responses, acknowledged graceful shutdown. Outer managed Windows Job contains controller/descendants; success requires clean Gateway shutdown and observed descendant settlement before forced Job cleanup. No synchronous sampler/startup profiler.

`windows-installed-startup-<runId>-<runAttempt>` retains all nine slots, errors, package/runtime/helper hashes, source/tooling commits, hardware, raw installed npm lockfile, cleanup evidence. Streamed `cohort.log` preserves active PID, phase, child output, completed check/RPC observations even if cancellation prevents final checkpoint. Synthetic databases/compile caches stay in runner temp. Failed/interrupted cohorts establish no summary. Fresh means new state, not cold filesystem; dedicated-runner results establish a baseline, not speedup against another desktop. Health RPC success is separate from plugin availability/degraded diagnostics.

Matched comparison: `installed_startup_package` = `{"baseline": <package-binding>, "candidate": <package-binding>}`, same fields above. Resolve/normally install both on one runner before measuring. Same version/dependency graph required; complete npm locks must match except independently verified OpenClaw tarball references/integrity. Drift stops before Gateway startup; retain both raw locks.

Each arm has immutable install and separate synthetic state/cache, retained across restarts. 18 slots: fresh baseline then fresh candidate, then eight restart pairs alternating baseline/candidate and candidate/baseline. No discarded warmups/replacements. Failure stops, retains unrun slots, invalidates summary. Per-sample deadlines unchanged; outer lifecycle budget 30 → 60 minutes.

After all samples/descendants settle, report each arm’s established readiness, absolute first status/health completion, and paired candidate-minus-baseline differences (negative favors candidate). Fresh samples separate. Alternating order reduces time-order bias; it neither makes filesystems cold nor establishes other-machine performance.

CPU attribution: `installed_startup_cpu_diagnostic=true` with one binding runs unprofiled fresh prime, then native CPU profile of established launch using same state. Both require readiness, first status/health, acknowledged shutdown, descendant settlement. No timing summary/paired comparison. Artifact retains raw `.cpuprofile`, main process/thread identity, preload clock observations, startup trace metrics, config hashes, backup-existence facts. Preload monotonic/performance observations support within-Gateway calibration. Controller/Gateway/native-profile clock domains are identified but unaligned: never compare absolute values across them or assume last profile sample includes preload exit observation. Console/stream traces share diagnostic observer, including Bun. Profiling/tracing adds overhead; main-isolate samples exclude unprofiled child/Worker CPU. Ordinary timing remains uninstrumented.
