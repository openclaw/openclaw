---
summary: "Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Probe"
read_when:
  - You are dispatching CI or Full Release Validation by hand
  - You need the Windows Testbox Probe inputs
title: "Manual dispatches"
sidebarTitle: "Manual dispatches"
---

Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Probe. Part of the [CI scope and routing](/ci/scope-and-routing) index.

## Manual dispatches

Ordinary manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 24 minimum compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, full iOS build/test and screenshot qualification, and Control UI/native app i18n. Their logical runner profile is always `github`, independent of the physical fallback selected by `runs-on`. Node 24 minimum compatibility runs in Full Release Validation and manual dispatches only; push and pull request CI skip it. The exact-head `release_gate` fallback instead keeps the pull request's macOS, iOS smoke, and generated-native-locale scope without selecting iOS screenshots or native tests. Automatic source PRs and release gates verify native extraction inventory and Android/Apple localization safety without requiring translated or platform-generated output in the same PR. The serialized Native App Locale Refresh workflow rebuilds those artifacts in one isolated PR and enables exact-head auto-merge after required checks pass. Native parity remains blocking for generated-artifact PRs, generated-scope release gates, ordinary manual CI, full-scope release validation, and release prep. CI reports proven obsolete native translation IDs and Android generated rows as warnings while the locale refresh catches up; active-key coverage, correctness, and all other parity checks remain blocking. See [local checks](/ci/local-proof) for the exact boundary. Control UI locale parity remains advisory on automatic PR and `main` runs and blocking on manual/release CI. Standalone manual CI dispatches run Android only with `include_android=true` (the `release_gate` input also forces Android); full-scope release validation enables Android by passing `include_android=true` without setting `release_gate`; npm qualification scopes defer Android. Plugin prerelease static checks, the full `agentic-plugins` sweep, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

PR baseline ratchets derive their comparison state from the checked-out synthetic merge tree and verify its head parent against the event head. The max-lines entry chains the environment-variable budget with the same fork-point ref before the assertion-safety check, so production source growth cannot first surface on `main`. Manual runs use a unique concurrency group so a release-candidate full suite is not cancelled by another push or PR run on the same ref. The optional `target_ref` input lets a trusted caller run that graph against a branch, tag, or full commit SHA while using the workflow file from the selected dispatch ref; ratchet baselines are compared with the target's merge base against the default-branch head resolved for that run. The `release_gate` input is an exact-SHA maintainer fallback for capacity-stalled PR CI: it requires `target_ref` to be a full commit SHA that matches the dispatched branch head and `pull_request_number` to identify the open PR whose merge tree is validated. Release-gate merge-tree lint uses the same five core stripes as hosted PR CI plus one extension stripe, so no single hosted runner owns the full type-aware lint workload.

Ordinary canonical manual CI also retains QA Smoke's full profile and Control UI
performance without owner-path filtering. When the target declares
`docker-seed-e2e-contract-v1`, it selects `published-upgrade-survivor`, preserving
the exact `legacy-operator-state` plus `auto-auth` proof used by every admitted
canonical main run. Every ordinary manual dispatch adds `cron-mcp-cleanup`, `fleet-cache`,
`mcp-channels`, `mcp-code-mode-gateway`, and `update-channel-switch` through
`resolveDockerSeedLanes`, including `npm-beta` and `npm-stable` qualification.
Older targets without the tier selector retain the survivor. Ordinary manual CI
builds the full package. The main-only `ciArtifacts` preparation also applies to admitted main-shape qualification
dispatches, which reproduce the main job for timing comparisons.
Pull requests and exact-head `release_gate` fallbacks omit Docker seed and QA Smoke.
Full Release Validation reaches these lanes through its normal CI child without
setting `release_gate`; frozen targets retain their existing capability checks.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
VALIDATION_SHA="<full-commit-sha>"
gh workflow run full-release-validation.yml --ref main \
  -f trusted_workflow_json='{"trustedWorkflow":null,"validationPurpose":"diagnostic","publicationSelection":null}' \
  -f ref="$VALIDATION_SHA" \
  -f expected_sha="$VALIDATION_SHA"
```

Gateway extended-stable shared publication requires complete exact-target Full
Release Validation from the trusted main-pinned `release-ci/*` harness targeting
the frozen `extended-stable/YYYY.M.33` tip. Direct canonical-branch and `main`
producers do not satisfy the protected publisher. Current
manifests also supply qualified npm preflight artifacts. The shared
`OpenClaw Release Publish` parent dispatches from a protected lightweight
`release-publish/<sha12>-<epoch>` tag at the frozen trusted-main Tooling SHA and
uses `npm_dist_tag=extended-stable` to publish official npm plugins and core, attach evidence, publish Docker, and
finalize a non-Latest GitHub Release. Only `extended-stable*` container aliases
advance; ClawHub, native-app, website, regular npm `latest`, and private
dist-tag surfaces are excluded. Core-resume recovery verifies existing registry
bytes before resuming evidence and finalization; Docker-only recovery leaves
GitHub finalization untouched. See [Monthly Gateway extended-stable
publication](/reference/RELEASING#monthly-gateway-extended-stable-publication)
for commands and recovery.

### Windows Testbox Probe

The manual `windows-testbox-probe.yml` workflow keeps Windows/WSL probing and
headless Windows CI on the selected `runner_label`. The `run_windows_ci` input
(default `false`) requests both headless CI and a separate native Scheduled Task
proof job on GitHub-hosted `windows-2025`. Neither job depends on the other, so
their results remain independently visible; either requested proof failing fails
the workflow.

For both proofs, set `target_ref` to an exact 40-character commit SHA. Both jobs
check out that target, and native proof verifies checkout equality before running
the lifecycle test. Native preflight runs before setup and requires an interactive
Windows session. A noninteractive runner fails qualification rather than silently
skipping proof. Selecting `windows-2025` does not establish native qualification:
the unchanged lifecycle assertions and cleanup must pass on the actual runner.
Cleanup and diagnostic upload still run after failure, and retained evidence is
removed only after cleanup and upload succeed.

#### Exact Windows test replay

For an ordered diagnostic from a recorded CI failure, set `windows_ci_replay`
to a JSON object with `nodeVersion`, `packageManager`, `vitestVersion`,
`maxWorkers`, `files`, and `projects`. Use an exact Node 24 patch and the
checkout's complete pnpm integrity pin and Vitest version. `maxWorkers` is an
integer from 1 through 4. `files` is the original ordered array of literal,
tracked test paths; `projects` is the original ordered array of
`test/vitest/vitest.<name>.config.ts` paths. Globs, shell text, arbitrary CLI
arguments, and environment overrides are not accepted.

Set `target_ref` to the exact source SHA, select the original `runner_label`,
set `keepalive_minutes=0`, and leave all other proof modes off. This runs only
the existing `scripts/test-projects.mts` entrypoint with `--fileParallelism`,
one project process at a time, the requested worker count, and the original
Windows CI heap and extension-shard settings. Normal CI worker policy is
unchanged. Runtime preparation and process lifetime stay with the frozen
source's dispatcher; the workflow does not copy current test tooling into it.

Run baseline and failing sources as separate, serialized workflow invocations
at the same reviewed workflow revision. Each gets its own runner checkout and
frozen install; never switch sources in an active checkout. Record actual
CPU/RAM from both runs rather than inferring capacity from the runner label.

The `windows-ci-replay-<runId>-<attempt>` artifact retains the input, source and
workflow identities, dependency hashes, native runtime/resources, exact argv,
combined output, process status, observed project order, and retained-namespace
diagnostics. A successful test command without the complete expected project
sequence fails qualification. An earlier failure retains its partial sequence
and remains failed. No replay retries or pass/fail waivers are added.

There is no persistent Testbox lease, SSH setup, or keepalive. The existing test
owner handles ordinary lifetime; Actions owns final job/runner teardown. A
frozen Windows runner can retain temporary namespaces when descendant settlement
is unverified. Do not delete them during the run or infer settlement from a
zero process status. Preserve that diagnostic, inspect final runner cleanup,
and report any missing teardown evidence separately from the test result.

#### Installed repair-worker compatibility and cleanup

Set `installed_repair_worker=true` with one `installed_startup_package` binding,
`runner_label=windows-2025`, and `keepalive_minutes=0`. Pin `target_ref` to the
same reviewed commit as the dispatched workflow. Leave other proof modes off.
The existing package owner installs and verifies the exact candidate artifact;
the native admission gate requires a fresh hosted runner without credentials,
operator mounts, Tailnet attachment, or managed identity.

The probe authenticates and installs npm versions 2026.9.4 and 2026.9.5, then
calls their unchanged published repair controllers against the installed candidate
worker. Version 2026.9.4 delegates its verifying phase; 2026.9.5 also delegates
validation. Each must receive the deferred unavailable result without provider
requests, validation calls, or changes to synthetic state. This proves controller
compatibility, not a complete installed-updater upgrade.

Separate cells use the candidate's packaged executor and ledger owners to admit
real delegated work against a loopback model fixture and reject a wrong receiver.
A real tool starts descendant processes. Both normal and forced worker exits must
remove them before the parent executor settles, while the outer observer and its
Windows Job launcher remain alive. Parent or outer cleanup cannot satisfy that
assertion. Original 90-second worker,
60-second turn, 120-second cell, and two-second extinction deadlines remain fixed.

The `windows-installed-startup-<runId>-<attempt>` artifact retains
`repair-results.json`, the failed or completed cells, native Job observations,
PID/start identities, exact package/controller/runtime/tooling hashes, synthetic
provider counts, state effects, and final cleanup. The probe stops after a failed
cell and never substitutes successful runner teardown for worker qualification.

#### Installed Gateway startup measurements

The same workflow can measure one immutable npm package on the selected Windows
runner. Set `target_ref` to the full tooling commit, `run_windows_ci=false`,
`keepalive_minutes=0`, and `startup_node_version` to an exact Node version
(default `26.8.2`). Leave WSL and Defender inputs at their defaults. The optional
`installed_startup_package` input is a JSON object with `runId`, `runAttempt`,
`workflowSha`, `artifactId`, `artifactDigest`, `packageSha256`, and `sourceSha`.
Use the immutable `package-under-test-<runId>-<runAttempt>` artifact from a
successful Package Acceptance run. The workflow verifies its producer and
artifact metadata, resolves it through the package-candidate owner, and installs
and rebuilds with normal npm lifecycle scripts.

After the benchmark's lifecycle fixtures pass on Windows, the installed
`openclaw.mjs` runs once with new synthetic state, then eight more times with that
same state. Each sample records HTTP readiness, first status and health RPC
responses, and acknowledged graceful shutdown. An outer managed Windows Job
contains the controller and all descendants; final success requires both clean
Gateway shutdown and observed descendant settlement before forced Job cleanup.
No synchronous process sampler or startup profiler runs during measurement.

The `windows-installed-startup-<runId>-<runAttempt>` artifact retains all nine
sample slots, errors, package/runtime/helper hashes, source and tooling commits,
runner hardware, the raw installed npm lockfile, and cleanup evidence. A streamed
`cohort.log` retains the active PID, phase, child output, and completed probe/RPC
observations even if cancellation prevents the final sample checkpoint. Synthetic databases and compile caches
stay in the runner's temporary directory. A failed or interrupted cohort has no
established summary. “Fresh” means new state, not a cold filesystem; dedicated
runner results establish a new baseline and do not establish a speedup relative
to a different desktop. Health RPC success is separate from recorded plugin
availability and degraded diagnostics.

For a matched comparison, pass `installed_startup_package` as
`{"baseline": <package-binding>, "candidate": <package-binding>}`. Both bindings
use the same fields above. The workflow resolves and normally installs both
packages on one runner before measurement. Their complete npm lock records must
match, except the independently verified OpenClaw tarball references and integrity.
Any dependency drift stops the comparison before a Gateway starts; both raw locks
remain evidence. The packages must have the same version and dependency graph.

Each package has its own immutable install and synthetic state/cache directory.
The cohort plans 18 slots: fresh baseline then fresh candidate, followed by eight
restart pairs alternating baseline/candidate and candidate/baseline order. Both
arms retain their own state across restarts. There are no discarded warmups or
replacement samples. A failure stops the cohort, retains the remaining unrun
slots, and invalidates the comparison summary. The per-sample deadlines stay the
same; the outer lifecycle budget scales from 30 to 60 minutes for two arms.

After all samples and descendants settle, the comparison reports each arm's
established readiness and absolute first status/health completion, plus paired
candidate-minus-baseline differences. Negative differences favor the candidate.
Fresh samples remain separate. Alternating order reduces time-order bias; it
does not make the filesystem cold or establish performance on other machines.

For CPU attribution, set `installed_startup_cpu_diagnostic=true` with one package
binding. This separate mode runs one unprofiled fresh prime, then one native CPU
profile of an established launch using the same synthetic state. Both launches
still require readiness, first status/health requests, acknowledged shutdown,
and descendant settlement. It produces no timing summary or paired comparison.
The artifact retains raw `.cpuprofile` files, the main process/thread identity,
preload clock observations, startup trace metrics, config hashes, and backup-existence
facts. The preload's monotonic and performance-clock observations remain available
for calibration within the Gateway process. Controller, Gateway, and native-profile
timestamps have separately identified clock domains; their alignment is not
established. Do not compare absolute values across those domains or assume that a
profile's last sampled timestamp includes the preload's exit observation.
Console and stream trace output share the diagnostic observer, including under Bun.
Profiling and trace observation add overhead; main-isolate samples do not
account for unprofiled child or Worker CPU. Ordinary timing cohorts remain
uninstrumented.
