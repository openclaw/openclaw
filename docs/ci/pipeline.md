---
summary: "Job graph, fail-fast order, and the Control UI size budgets"
title: "CI pipeline jobs"
read_when:
  - You need to know which CI job owns a check
  - You want the order jobs run in and what blocks what
  - You need to satisfy or configure security-sensitive pull request review
---

OpenClaw CI runs on pushes to `main` that change a path outside `**/*.md` and
`docs/**`, on every non-draft pull request, and on manual dispatch. Docs-only
main pushes skip CI; mixed docs and code pushes still run it. Pull-request docs
scoping is unchanged.
Canonical `main` pushes use a two-slot pipeline keyed by run-number parity, so
at most two integration runs overlap. Each slot is non-canceling and keeps one
coalesced pending tip: a new merge replaces that slot's older pending run
instead of canceling work that already registered a Blacksmith matrix. Runs in
the two slots can complete out of order; exact-head consumers remain bound to
their requested SHA and are unaffected. Pull requests still cancel superseded
heads, and manual dispatches use isolated groups. Draft no-op events use per-run
isolated groups before job gating, so a delayed draft event cannot displace
pending or running ready-for-review CI. `converted_to_draft` keeps the PR-wide
group to cancel earlier CI while skipping its own jobs. Explicit workflow
cancellation and manual dispatch behavior are unchanged; draft isolation adds no
downstream automatic recovery. `preflight` classifies the
diff and turns expensive lanes off when only unrelated areas changed. Ordinary
manual `workflow_dispatch` runs intentionally bypass smart scoping and fan out
the full graph for release candidates and broad validation. Exact-head
`release_gate` fallbacks retain the pull request's macOS, iOS smoke, and native
generated-locale scope instead of forcing unrelated Apple lanes or locale
parity. Native source verification still runs. Android lanes stay opt-in through
`include_android` (or the `release_gate` input). Release-only
plugin coverage lives in the separate
[`Plugin Prerelease`](/ci/release-validation#plugin-prerelease) workflow and only runs from
[`Full Release Validation`](/ci/release-validation#full-release-validation) or an explicit manual
dispatch.

Scheduled QA runs nightly at 04:41 UTC. Its live runtime job runs the
`gateway-restart-full-access-live` scenario with `openai/gpt-5.6-luna` alongside
the three-restart replay-safety scenario. The Full Access check must preserve
shell access and delegation without repeating the interrupted side effect;
failure fails the job. Both scenarios run serially and retain their reports in
the job's uploaded artifacts.

## Pipeline overview

| Job                              | Purpose                                                                                                                                                                                                                                                                                                  | When it runs                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `preflight`                      | Detect changed scopes and build the CI manifest; all-Blacksmith canonical Node-relevant runs also restore the exact dependency cache before fanout                                                                                                                                                       | Always on non-draft pushes and PRs                 |
| `security-fast`                  | Private key detection, changed-workflow audit via `zizmor`, and production lockfile audit                                                                                                                                                                                                                | Always on non-draft pushes and PRs                 |
| `build-artifacts`                | Build `dist/`, Control UI, built-CLI smoke checks, startup memory, and embedded built-artifact checks                                                                                                                                                                                                    | Node-relevant changes                              |
| `control-ui-performance`         | Compare Control UI CSS with the exact base revision and enforce asset budgets independently of artifact generation                                                                                                                                                                                       | UI/build/dependency/import owners and manual CI    |
| `control-ui-i18n`                | Verify generated Control UI locale bundles, metadata, and translation memory; advisory on automatic runs, blocking on manual release CI                                                                                                                                                                  | Control UI i18n-relevant changes and manual CI     |
| `checks-fast-core`               | Fast Linux correctness lanes: environment-variable, max-lines suppression and PR line-cap growth ratchets, assertion-safety baseline, bundled + protocol, Bun launcher, and the CI-routing fast task                                                                                                     | Node-relevant changes                              |
| `qa-smoke-ci-profile`            | Self-contained balanced parts of the automatic QA Smoke coverage set; one private-overlay build per part (the smoke set has no docker-lane or Control UI scenarios; the run step fails closed if one returns)                                                                                            | QA-owned main changes and ordinary manual CI       |
| `checks-fast-contracts-plugins`  | One setup shared by two sequential weighted plugin contract processes; frozen targets keep separate rows                                                                                                                                                                                                 | Node-relevant changes                              |
| `checks-fast-contracts-channels` | One setup shared by two sequential weighted channel contract envelopes; frozen targets keep separate rows                                                                                                                                                                                                | Node-relevant changes                              |
| `checks-node-*`                  | Changed-target Node tests on pull requests; compact integration shards on `main`; metadata-complete compact fallback on broad PRs; full named shards on manual and release runs                                                                                                                          | Node-relevant changes                              |
| `docker-seed-e2e`                | One Docker scheduler job for the executable MCP, update-channel, Fleet cache, and published-upgrade owner lanes; the published upgrade seeds legacy operator state on an exact published predecessor                                                                                                     | Owner main changes; survivor on ordinary manual CI |
| `check-*`                        | Sharded main local gate equivalent: guards, transient npm-lock validation, bundled-channel config metadata, prod types, lint, dependencies, test types                                                                                                                                                   | Node-relevant changes                              |
| `check-additional-*`             | Boundary check stripes (including prompt snapshot drift), session accessor/transcript reader/SQLite transaction boundaries, extension lint groups, package boundary compile/canary, and runtime topology architecture; the pure-reporting plugin SDK API diff runs on manual and release dispatches only | Node-relevant changes                              |
| `checks-node-compat-node24`      | Node 24 minimum compatibility build and smoke lane                                                                                                                                                                                                                                                       | Full Release Validation and manual dispatches only |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                                                                                                                                                                                                                            | Docs changed (PRs and manual dispatch)             |
| `native-i18n`                    | Verify native source extraction and localization safety on source PRs and release gates; enforce generated parity on generated PRs, generated-scope release gates, and ordinary manual CI                                                                                                                | Native i18n-relevant changes                       |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                                                                                                                                                                                                                                   | Python-skill-relevant changes                      |
| `checks-windows`                 | Windows-specific process/path tests plus shared runtime import specifier regressions                                                                                                                                                                                                                     | Windows-relevant changes                           |
| `macos-node`                     | Focused macOS TypeScript tests: launchd, Homebrew, runtime paths, packaging scripts, process-group wrapper                                                                                                                                                                                               | macOS-relevant changes                             |
| `macos-swift`                    | Swift lint and build for the macOS app, plus tests for the app, shared OpenClawKit, and standalone Swabble package                                                                                                                                                                                       | macOS-relevant changes                             |
| `ios-build`                      | Debug build and Swift lint smoke; full manual CI adds separate Release device and native test phases                                                                                                                                                                                                     | iOS/capture changes and full manual CI             |
| `ios-screenshot-shard`           | Two device-family shards using the locked Ruby/Fastlane bundle: iPhone in one job, and 13-inch iPad plus Watch in the other; scenarios stay serial within each device                                                                                                                                    | Full manual CI only                                |
| `ios-screenshot-evidence`        | Hosted reducer that verifies exact artifact/family topology, digests, every OpenClaw-managed capture-attempt outcome (including failed invocations without an xcresult), and run provenance before publishing the canonical release screenshot artifact                                                  | After both screenshot shards                       |
| `android`                        | Phone and Wear unit tests, debug builds, Android lint, and Kotlin lint                                                                                                                                                                                                                                   | Android-relevant changes                           |
| `openclaw/ci-gate`               | Final aggregate: requires preflight and security; rejects selected skips and every downstream failure or cancellation                                                                                                                                                                                    | Every non-draft CI run                             |
| `openclaw-performance`           | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                                                                                                             | Scheduled and manual dispatch                      |
| `docs-external-links`            | Separate workflow: Docs External Link Audit checks external documentation links with lychee and uploads a report; it reports findings without failing, so it never blocks a pull request                                                                                                                 | Scheduled and manual dispatch                      |

### Test runtime selection

Linux test shards select Bun through `scripts/lib/ci-test-runtime.mts`. The
ordinary and isolated unit-fast lanes partition their existing file inventories: files with known Bun
failures or additional skips stay on Node, and the compatible remainder runs on
Bun. Those Node files still execute; they are not excluded from CI. The complete
fake-timer lane also supports Bun. UI and other families retain Node until they
pass on the pinned fork within their existing CI resource budgets. Precise PR targets use the existing
test-project planner to find their owners. Mixed or ambiguous selections retain
Node, and no tests are removed from the selected inventory.

Pull requests and their release-gate fallback run compatible selections on Bun.
Ordinary manual CI, including Full Release Validation's `normal_ci` child, runs
the complete original selection on Node and its compatible portion on Bun
within the same job and worker slot. Other selections run on Node. Main pushes retain Node. Historical targets
without the runtime-selection capability keep their original Node behavior.

The test-runtime setup action installs a checksum-pinned build of the Bun fork
only for jobs that need it. The source commit, archive checksum, and executable
checksum live together in `.github/actions/setup-test-bun/action.yml`.
Node continues to own orchestration, builds, compiler preparation, and cleanup;
Vitest and its workers use the selected runtime. Bun and Node have separate
transform-cache directories and timing identities. Either runtime failing fails
the job. This adds no matrix rows or runner registrations.

`NODE_OPTIONS` continues to limit Node heaps; Bun does not use that V8 heap
limit. Compare observed memory use alongside elapsed time before admitting more
lanes. Compatibility evidence must use the exact fork build installed by CI;
stock Bun results and different fork revisions are separate measurements.

### Node execution and runtime compatibility

Most Node test, lint, and typecheck jobs currently inherit `24.x` from
`.github/actions/setup-node-env`; the Node shard also supplies that default
explicitly. The composite's `ensure-node.sh` reuses a matching active or cached
runtime before downloading one. A wildcard therefore does not guarantee the
newest patch. Compare exact versions when measuring a toolchain change, and
measure setup separately from the test body.

Preflight's manifest bootstrap uses the exact `NODE_VERSION` pin in `ci.yml`
(24.19.0). Unlike the repository helper, `actions/setup-node` can satisfy a
`24.x` request from an older cached patch below OpenClaw's support floor.

CI's execution version does not define the supported user runtime matrix.
`package.json` accepts Node 24.16+ and Node 26.1+. The full manual CI graph checks
the Node 24.16.0 floor; `node-runtime-compat.yml` checks Node 26.1.0 weekly and on
dispatch. Current packaged fresh-install and upgrade checks run on both
Node 24.19.0 and Node 26.1.0, with Windows Node 24 fresh-install proof on 24.16.0.
Both runtime variants use the same candidate package. These support cells stay
independent of changes to the ordinary execution pin; source/build smoke alone
does not prove an installed upgrade. See the
[package validation matrix](/ci/release-validation/package-acceptance).

Select a supported Node runtime before project commands, including lightweight
workflow checks and release orchestration. Hosted images can default to Node 22;
an absent version pin does not prove a supported runtime. Runner images can also
contain unused older toolchains, and recovery bundles intentionally retain
older syntax targets so unsupported runtimes can print upgrade diagnostics.
Those are separate from the supported runtime and test-job versions. GitHub
JavaScript actions also have their own runtime, independent of the `node` on
the job's `PATH`.

### macOS Swift phases

`macos-swift (tests)` builds and runs the app's complete default- and named-profile
test partitions with coverage. `macos-swift (packages)` independently runs the
OpenClawKit Talk-trait opt-out build, OpenClawKit tests, and Swabble tests. These
separate package graphs previously ran before the app build in one job; a hosted
baseline spent 7m57s on them in a 21m48s job. Separating them gives app compilation
and tests their own 30-minute budget without removing coverage or increasing
test-process parallelism.

Both phases use `macos-26`, with at most two concurrent jobs. Full manual
validation adds the existing `release` phase under the same cap. This adds one
hosted Mac job and its checkout/setup cost per selected run, with no additional
Blacksmith registrations. Compare complete hosted timings, including queue and
setup time, before treating the removed serial work as an observed speedup.

Only the app phases restore the app build cache. SwiftPM dependency caches remain
restore-only in `packages`; the existing primary phase owns shared cache writes.
The aggregate gate requires every selected phase to succeed.

Debug Swift CI builds omit the IDE index and use line-table debug information.
Coverage instrumentation and source-line backtraces remain enabled; interactive
debugger type/value inspection requires a normal local debug build. The app test
cache uses a separate build profile so it cannot restore the old indexed products;
Release build flags and caches remain unchanged.

Ordinary Markdown and MDX pages under `docs/`, plus root `README.md`, retain
their separate `check-docs` coverage beside precise pull-request Node tests.
Page deletions and renames preserve this targeting. Explicit Node owners for
Markdown inputs remain selected; workspace templates under
`docs/reference/templates/` and unowned source inputs retain the full fallback.

When `docker-seed-e2e` selects the published upgrade survivor, it uploads
`docker-seed-upgrade-survivor-proof` even after a failure. The artifact contains
scheduler summaries and sanitized survivor reports. Failed reports include
bounded, redacted baseline and candidate agent-turn output; private scenario
state and raw logs remain outside the upload.

Full canonical `main` pushes run the operator config and prior-release state
startup corpora once through the Node `runtime-config` owner. Canonical pull
requests also omit the duplicate **Check startup corpus** step when preflight
certifies every corpus file in the required Node matrix on the exact same
checkout revision. Partial, filtered or unknown plans retain the explicit step;
release-gate dispatches retain their separate merge-tree proof. Both state
repair passes, all static baseline ratchets and required Node failure aggregation
remain unchanged.
Eight state test files share one matrix inventory so the executor can distribute
all release/config pairs across workers. Each pair still runs both Doctor and
Gateway startup checks. The explicit step prepares the runtime once with
`pnpm build qaRuntime`, then runs the config corpus and all eight state files in
one Vitest process with at most four workers. A failed preparation stops the step
before workers consume memory or attempt their own builds. Frozen targets from
before the file split retain their config process and four state processes.
The corpus uses the normal bundled-plugin resolver to select the prepared
runtime from this checkout instead of forcing TypeScript plugin entrypoints.
Plugins whose Doctor contracts require source loading retain that behavior;
the complete config/state matrix and its assertions remain intact.

Ordinary pull requests that change only independent Control UI unit-test entries
keep all three UI unit rows and existing type/lint gates,
without repeating dedicated UI E2E jobs. Browser and Node test entries, shared
fixtures/helpers, production or build inputs, and tests imported by another
owner retain E2E coverage. Main pushes, manual validation, and frozen targets
keep their existing selection.

The `docker-seed-e2e` job selects the executable owners of changed E2E helpers
and the published-upgrade regression gate through one scheduler invocation.
The published lane runs `legacy-operator-state` against an exact published
predecessor on affected canonical `main` pushes. Canonical manual CI
retains it when the target declares the Docker seed capability. Unknown changed
paths retain survivor coverage; docs-only pushes remain excluded at the trigger.
It uses `auto-auth`: every supported baseline must replace the running managed
Gateway through its own updater. Schema refusal or rollback fails the gate.
Main selection includes `src/cli/update-cli/**`, `src/infra/update-*`,
`src/infra/package-update-*`, `src/plugins/update.ts`, `src/plugins/update-*`,
`src/commands/doctor*`, `src/commands/doctor/**`, all `src/state/**`, and
`package.json` (including its packaged schema-version metadata). It also includes
`scripts/e2e/upgrade-survivor*`, `scripts/e2e/lib/upgrade-survivor/**`, the survivor
policy and baseline resolver, the Docker planner/catalog, and this gate's CI
workflow, Docker selector (`scripts/lib/ci-docker-seed-plan.mts`), and shared
test-path classifier. Node-only planner edits do not select Docker lanes. The
Node planner retains its selector export for older target/harness combinations.
Tests independently pin both state and agent schema-version constant owners to
the published lane.
The scheduler retains one 16-class Blacksmith runner on eligible main pushes
and its existing serial main/manual lane admission. Pull requests and their
exact-head fallback dispatches do not select this proof. Installed-driver
upgrade coverage remains required when selected on main and ordinary manual
release CI; the existing infrastructure timeout stays unchanged.
The job is part of `openclaw/ci-gate`. It uses at most one runner registration per
selected run; adding the survivor does not increase the existing full-inventory
registration cap, job count, or matrix fanout.

Standalone Periphery workflows enforce zero dead-code findings for the iOS and macOS apps. The shared OpenClawKit workflow scans both consumers in parallel and reports a declaration only when Periphery emits the same Swift USR from both builds. Its generated `OpenClawProtocol/GatewayModels.swift` schema contract is retained as generator-owned code rather than treated as app-local dead code.

All four scans use `scripts/install-periphery.sh` to install the checksum-pinned Periphery 3.8.0 OSS release, including its adjacent `libIndexStore.dylib`, in a dedicated runner-temporary directory. The installer rejects download, checksum, and version failures without falling back to Homebrew. Installer changes select all three native workflows.

[Upstream archived the OSS project](https://github.com/peripheryapp/periphery/commit/56a0eb6fb97b785c8fbc1044ccbc7b5d9f06ebec). The pin is a maintainer-owned bridge for the workflows' Xcode 26.6 toolchain, not a claim of ongoing upstream support. Native CI maintainers must revalidate both app scans and both shared consumers before changing Xcode, the pinned release, or the analyzer; retain the zero-findings policy and exact-USR intersection rather than adding a baseline or a weaker fallback.

## Security review checks

Security review separates product changes that maintainers can approve from the
small set of security policy and enforcement files that require SecOps approval.

| Change                                     | User account with `maintain` or `admin` access   | Other authors                                                                    |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Sensitive product code                     | Informational notice; no extra security approval | `/allow-security-sensitive-change` from a user with `maintain` or `admin` access |
| Dependency changes requiring review        | Same maintainer exemption                        | `/allow-dependencies-change` from a user with either role                        |
| SecOps-owned files in `.github/CODEOWNERS` | Independent SecOps code-owner approval           | Independent SecOps code-owner approval                                           |

The **Security Review** workflow runs both guards from trusted repository code.
It publishes a commit status named `openclaw/ci-gate` that requires both the
applicable approvals and a successful native CI gate from the latest CI run for
the current PR head. The existing CI job retains its check with the same name.
GitHub requires both the check and the commit status when both share a required
context. Missing approval, failed CI, or evaluation errors fail the review status.
Missing or running CI leaves it pending and keeps merging blocked. CI completion
automatically evaluates it again. Approval comments do not rerun the test suite.
The Security Review Actions job succeeds when evaluation completes, including
when the required commit status blocks merging for missing approval or failed CI.
This prevents an earlier evaluation from leaving a stale failed job after automatic
reevaluation clears the status. Evaluation errors still fail the job and keep the
required status closed.

When GitHub returns a rate-limit response, the resolver and review scripts stop
API requests, honor `Retry-After` and exhausted-quota reset times, and restart
with fresh PR, approval, role, and CI data. Each script permits up to three restarts
within a shared 65-minute deadline for its job; individual HTTP requests still
have a 30-second timeout. Secondary limits without timing guidance use at least
one minute of exponential backoff. Small randomized delays spread retries after
quota resets. Jobs have a 75-minute ceiling, and waiting occupies their runner.
Recovery is automatic in the same run and does not require another PR event or
manual dispatch. Exhausted recovery fails the job without publishing success;
quota exhaustion can also prevent a new status from being published. Ordinary
permission errors, uncertain writes, and other evaluation errors are not retried.
Checkout, runtime setup, and separately minted autoscrub token expiry are outside
this recovery mechanism.

If GitHub's changed-file count and file list disagree, the guards retry the complete
file-list read after one, two, and four seconds. Each retry rereads PR metadata;
changes to the head, target branch, or author still invalidate the evaluation.
Both guards share the validated result and retry budget. A persistent mismatch
fails the review and reports the expected, returned, and current file counts.

The **Security Sensitive Guard** publishes `openclaw/security-sensitive-review`.
Its inventory in `.github/security-review-policy.yml` covers Gateway
authentication, pairing and permissions; credentials, secrets and redaction;
sandbox and execution policies; product security checks; and `.gitignore`.
Ordinary documentation, tests, and test support do not trigger this inventory.
Renames inspect both the old and new paths so moving a sensitive file does not
remove its review requirement.

The **Dependency Guard** publishes `openclaw/dependency-review` and retains its
dependency classification and lockfile autoscrub behavior. Dependency removals
that already qualify as informational remain informational.

Edit `.github/security-review-policy.yml` to change path classification. Its
`categories` group product paths with descriptions and review guidance;
`exclude` names the product-only exclusions; and `dependencies` lists manifests,
lockfiles, and other dependency files. Paths are quoted, repository-relative
globs: `*` stays within a path segment, `**` crosses directories, and `{a,b}`
matches either alternative. Hidden paths are included. Matching is
case-sensitive unless an exclusion explicitly sets `case-insensitive: true`.
Product exclusions never exempt dependency changes. The first matching product
category supplies the notice's guidance; matches are not CODEOWNERS rules.

The JavaScript loader handles validation and matching; it contains no path
inventory. Invalid policy fails security review. Both the
YAML inventory and its loader require SecOps code-owner approval. The workflow
loads them from the trusted checkout and installs only the locked parser/matcher
runtime through `.github/actions/setup-security-review`, with lifecycle scripts
and dependency caches disabled. That action's manifest and npm lock mirror the
root dependency pins and `pnpm-lock.yaml`; update them together when those pins
change. Approval decisions and dependency graph analysis remain in JavaScript.

Both guards use current repository permissions. Only GitHub user accounts with
`maintain` or `admin` access can grant command approval or receive the author exemption.
`write` access and organization membership are insufficient. A maintainer pushing
to an external contributor's branch does not transfer the author exemption.
Automation using a GitHub user account qualifies under the same role check;
GitHub App bot identities do not qualify.

For other authors, wait for the applicable guard notice to show the current PR
commit, then post the command on its own line in a new PR comment:

```text
/allow-security-sensitive-change
/allow-dependencies-change
```

Each command approves only its own guard. When both guards require approval, both
commands are required and can appear on separate lines in one comment. Use only
command lines in that comment, without prose, quotes, or code fences. Normal
GitHub **Approve** reviews and labels do not replace these commands.

The guard associates a command with the revision recorded in its trusted notice.
A command posted before the notice requests approval for that revision cannot
approve it. After a new commit, wait for the notice to update and post a new
comment. Editing an older comment does not grant fresh approval. Deleting an
approval comment or removing its command revokes that approval; current roles
are checked again whenever the guard runs.

GitHub commit statuses apply to a commit rather than one PR. Before publishing
success, security review verifies that the head belongs to only the current open
PR targeting that base branch. Duplicate heads block approval so one PR cannot
reuse another PR's author exemption or command. Close the duplicate PR or push a
distinct commit; security review evaluates the affected PRs automatically.

Each guard updates one PR comment with affected files, review guidance, the
current revision, and the remaining action. The sensitive-change label remains
after approval so reviewers can still identify the affected responsibility.
Trusted `issue_comment` events reevaluate approval commands and edits or
deletions of approval comments automatically. Edits inspect both the previous
and current text so removing a command still revokes approval. Ordinary comment
activity does not reevaluate the guards or change their statuses. Command mentions
in prose, quotes, or code fences are not approval comments. The workflow filters
ordinary comments before allocating a runner; a command mention can start the
lightweight resolver, which validates the syntax before scheduling review.
Both guards share one review job, and comment events do not rerun the test suite.
Evaluation uses trusted repository code and GitHub metadata without
executing contributor code or comment text.

The hard tier lives only in `.github/CODEOWNERS`: security policy, ownership,
CodeQL, selected scanning configuration, and the security-review enforcement
closure. Keep SecOps as the sole owner on those entries. GitHub accepts any owner
on a matching line, and later matching patterns replace earlier ownership. The
release-manager entries retain their separate approval responsibility. This
inventory does not make every general CI or scanner change SecOps-owned.

The soft tier protects the review flow for fork contributors. It is not a
security boundary against hostile repository writers: another workflow with a
write token can publish the same status context. Binding the required context to
the GitHub Actions app identifies the publisher app, not the specific workflow.
This is an accepted tradeoff to avoid a separate credential-bearing publisher.
The existing maintainer CI bypass also permits bypassing missing command approvals.
Native CODEOWNERS review enforcement remains independent of these statuses and
that CI bypass.

Results apply to the PR head evaluated by the workflow. New PR heads, base-branch
retargeting, command comment events, and CI completion reevaluate automatically;
unrelated pushes to `main` do not. Sensitive-path policy and permission changes
take effect on the next automatic evaluation. Guard execution does not require
manual dispatches or manual reruns.

### Enable enforcement after deployment

Merging workflow files does not enable GitHub merge protection. After the
workflow and the reviewed CODEOWNERS inventory are on the default branch:

1. Keep `openclaw/ci-gate` required and bound to the GitHub Actions app. Preserve
   the existing maintainer bypass and leave **Require branches to be up to date**
   disabled. The two review statuses remain visible without separate required-check entries.
2. Verify the native CI check and security review commit status on a PR's current
   head, including after command approval, a subsequent push, and CI completion.
   Confirm approval updates do not start another test run.
3. In a separate ruleset with no bypass actors, enable **Require a pull request**,
   **Require review from Code Owners**, and **Dismiss stale pull request
   approvals when new commits are pushed**. Verify that `openclaw-secops` is
   eligible for code ownership and that its approval is required for the hard
   inventory. Keep the general required approval count at zero if ordinary
   unowned changes should retain their existing review policy; code-owner review
   is a separate requirement. Existing release-manager entries also become required.
4. Verify that the CI bypass cannot skip the separate code-owner review rule.
   Requiring a PR also restricts direct pushes to the protected branch.

Verify the live GitHub settings and the maintainer, external contributor,
automation account, and SecOps-owned-path cases before declaring enforcement active.

## Fail-fast order

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs. Canonical `main` starts immediately in one of two parity slots; each slot admits one complete run and coalesces later pushes into its newest pending tip. Downstream jobs wait for the manifest, then eligible Blacksmith jobs restore exact dependencies from the trusted warmer or fall back to the ordinary pnpm-store cache on a miss. Pushes, pull requests, and manual runs targeting the workflow revision run preflight with native Node and skip dependency setup. Manual runs targeting a different revision install dependencies and retain that target's `tsx` tooling.
2. `security-fast`, `check-*`, `check-additional-*`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs. The production dependency audit sends one complete graph with up to four attempts and a four-minute total request budget, including retries and response reading. Timeouts, native fetch failures, HTTP 429, and 5xx responses retry with exponential backoff; retryable HTTP responses honor `Retry-After`. Attempts and recovery are logged. Persistent unavailability, vulnerability findings, invalid inputs, malformed advisory data, oversized responses, and permanent HTTP failures block CI. An unavailable audit is incomplete coverage, not a clean result. Local pre-commit and release dependency audits use the same bounded request owner and fail on unavailability.
3. `build-artifacts` and the locale checks overlap with the fast Linux lanes. Control UI and native app source PRs exclude generated locale snapshots/resources; their serialized refresh workflows repair and auto-merge isolated generated PRs in the background. Source CI still blocks stale source inventories and unsafe localization calls. Generated PRs, manual CI, and release prep enforce full translated/platform-generated parity. Canonical `release/YYYY.M.PATCH` branches may include release-prep locale repairs with the other generated release output.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-plugins`, `checks-fast-contracts-channels`, `checks-node-*`, `checks-windows`, `macos-node`, `macos-swift`, `ios-build`, the screenshot shards, and `android`.
5. `openclaw/ci-gate` waits for every selected lane. Preflight and security must succeed; downstream jobs may skip only when unselected by the manifest and existing event, runner, and compatibility conditions. An unexpected selected skip or any failed or canceled downstream job fails the aggregate. The aggregate uses `!cancelled()` so failed prerequisites still report, while canceling the workflow skips final reporting and releases its concurrency slot without waiting for another runner.

To retranslate every Control UI or native app string, dispatch **Control UI Locale Refresh** or **Native App Locale Refresh** from `main` with `full_refresh=true`. Ordinary runs remain incremental. Both workflows read the primary and fallback models from the `OPENCLAW_I18N_MODEL` and `OPENCLAW_I18N_FALLBACK_MODEL` GitHub secrets, using the existing translation OpenAI API key. Only an explicit `model_not_found` provider error selects the fallback; authentication, quota, and network failures do not. Generated metadata and public diagnostics omit model identifiers.

The merge coordinator may reuse an authenticated successful `openclaw/ci-gate`
for the same pull-request head for up to 24 hours. This avoids rewriting a
contributor branch after unrelated `main` changes. The reusable result does not
replace the separate strict, App-owned test-merge check against current `main`.
A later pending or failed rerun does not erase an earlier successful result for
that unchanged head during the freshness window.
Reusing a CI check does not replace the current security review commit status.

The default-branch ruleset requires the GitHub Actions-owned `openclaw/ci-gate`
context. Repository maintainers and admins retain their CI bypass, including
for missing command approvals. Normal pull-request merges use the gate. The
separate code-owner ruleset requires a PR and the applicable owner approval even
when CI is bypassed; organization rules still block deletion and non-fast-forward
updates. The separate strict App-owned test-merge check still binds the head to
current `main`.

GitHub may mark superseded pull-request jobs as `cancelled` when a newer head lands. Treat that as CI noise unless the newest run for the same PR is also failing. Canonical `main` runs are not canceled after admission; each of the two parity slots replaces only its older pending run with the newest tip. Matrix jobs use `fail-fast: false`, and `build-artifacts` reports embedded channel, core-support-boundary, and gateway-watch failures directly instead of queuing tiny verifier jobs. The canonical-main CI concurrency key is versioned (`CI-v8-*`) so GitHub-side zombies in the old group cannot block the two-slot pipeline; runnable PR groups remain on `CI-v7-*`, while passive draft runs use `CI-draft-v1-*`. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs. The plugin-list startup-memory guard keeps a 400 MiB ceiling on self-hosted Blacksmith Linux and allows 425 MiB on GitHub-hosted Linux, whose RSS baseline is higher for the same built CLI. The startup-memory check finishes alone before other built-artifact checks start on every runner, so concurrent verifiers do not perturb the RSS measurement.

The Testbox validation, native Periphery, OpenGrep PR Diff, Sandbox Common Smoke,
and Plugin Init Scaffold Validation workflows isolate passive draft PR events
(`opened`, `reopened`, and `synchronize`) from useful PR work at concurrency
admission. A delayed draft payload therefore cannot cancel an active ready run or
replace a pending one before the draft job or scan is skipped. Disabling
`cancel-in-progress` alone would still replace pending work. Where subscribed,
`converted_to_draft` stays in the ordinary PR group to intentionally cancel work;
non-draft head supersession and each workflow's existing manual/push grouping
remain unchanged. Periphery report publication separately checks source intent
and live PR state; see [Scope and routing](/ci/scope-and-routing).

The singleton smoke then rebuilds the runtime plugin overlay before any other verifier reads it. On Blacksmith, Gateway watch finishes its build-receipt writes and whole-tree measurement next; Doctor, SQLite lifecycle, channel, core-support-boundary, and Discord attachment checks can then overlap. Hosted 4-core runners keep their existing serial sequence and channel/core pair. TUI canaries run after all other verifiers finish. Every verifier owns a separate Vitest module cache, and each selected result remains part of the same failure aggregation. The wave step is unconditional because its startup and singleton checks always run; individual checks retain their selection gates. The artifact job consumes only its selected checkout, so base-commit fetching stays with jobs that actually compare revisions.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, start delay, slowest jobs, and failures from GitHub Actions. Use `pnpm ci:timings:trend` for a 72-hour baseline and a latest-12-hours versus prior-12-hours comparison. Trend mode includes every main push outcome, cancellation/pass rates, and successful-run wall time, then loads a balanced latest/prior sample of at most 100 successful runs by default. Its detailed sample separates workflow admission, job dependency/gate delay (`job.created_at` minus the first job's creation), runner queue/start latency (`job.started_at` minus `job.created_at`), and execution; it also reports critical-path ownership and the actual GitHub API request count. Reruns use attempt-specific jobs and are excluded from run-level wall/admission distributions because GitHub retains the original workflow creation time. Raise or lower the detailed-run selection cap with `--detail-runs` (a run with more than 100 jobs requires multiple requests), emit JSON to stdout with `--json`, or save the same report with `--output .artifacts/ci-timings/trend.json`; missing output directories are created automatically. The baseline must cover at least two comparison windows.

Run the timing helper locally; there is no in-workflow timing-summary job (a permanently disabled one was removed once the local helper became the tool everyone actually used). For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

The `Run Node test shard` step prints Bash `time -p` totals: elapsed (`real`), user CPU (`user`), and system CPU (`sys`) seconds, including waited-for child processes. Compare CPU totals with elapsed time across equivalent runs to distinguish extra CPU work from slower execution with similar CPU work. These totals alone do not establish runner contention.

Android test rows retain their existing Gradle JUnit XML for 14 days in
`android-test-reports-<task>-<checkout-revision>-<run-attempt>` artifacts, including
failed runs unless canceled. Reports identify test cases and durations; compilation,
lint, setup, and queue time remain separate in the job log. Read the XML alongside
that attempt's Gradle task outcomes: reports restored by `FROM-CACHE` or reused by
`UP-TO-DATE` describe an earlier execution, so their times are historical. They do
not show fresh test execution or a speedup in the current run. A failure before
Gradle writes XML can leave no artifact; the upload warns without replacing the
original failure. The artifact contains only phone and Wear unit-test XML, not
dependency caches or application build outputs.

Node test shards that need a built CLI run `pnpm build qaRuntime` before starting
Vitest. This profile builds runtime JavaScript, plugin assets, and freshness and
provenance metadata. Private QA shards select their private runtime entries. The
`build-artifacts` job owns Control UI and SDK declaration validation; release
package builds still generate the full declarations.

Source-only Linux Node 24 shards can restore compiled Vitest workers from the
protected cache warmer. The warmer prepares one generation before SDK or runtime
builds change package resolution, joins the preparation owner, and publishes only
the retained cache. PR jobs restore it without publishing. Consumers enable
reuse only when an archive exists; cold runners keep ordinary fresh compilation.
The worker owner verifies source and dependency bytes, compiler identity,
resolution topology, environment, output inventory, and the exact checkout and
output-slot paths before lending a generation. Changed or incompatible inputs
rebuild locally. Frozen targets, other Node versions, and runtime-building shards
retain fresh preparation.

The artifact job keeps its built outputs for its own smoke and boundary checks.
It no longer packs or uploads the unused `dist-runtime-build` and
`bundled-plugin-assets` archives. Runtime shards still start after preflight;
they do not wait for SDK declarations, the Control UI build, or artifact checks.
Diagnostic and proof uploads remain available.

Declaration caches hash the selected writer's transitive generator imports,
package and plugin metadata, explicit schema and build metadata inputs, and
the compiler's recorded source files. Editing an unrelated CI script does not
rebuild declarations. Resolution topology still participates in the cache key,
and an unresolved generator import stops the build instead of trusting a cache.

Local `pnpm build:ci-artifacts` uses the same memory admission as full and package
builds. The orchestrator passes the resolved heap budget to every child process,
including the SDK declaration writer, so local builds do not depend on CI's
`NODE_OPTIONS` setting. The existing policy accounts for host and cgroup limits
and reserves native-memory headroom. If the default budget cannot fit the build,
it stops before build steps or cache restoration; `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`
remains the explicit operator override for attempting a different budget.

## Control UI size budgets

`pnpm ui:build` produces and verifies the bundle, then reports its compressed
sizes. Budget violations do not prevent artifact generation. The separate
`control-ui-performance` job enforces the budgets without blocking other jobs
from building or testing the same source.

Startup CSS has a 45 KiB advisory target and a 50 KiB hard ceiling. Growth below
1 KiB passes; an increase of 1 KiB or more in either startup CSS or the largest
CSS file fails the comparison. The existing largest-file, JavaScript, request-count,
and isolated-renderer ceilings still apply independently. Reports include exact
bytes, base deltas, and remaining headroom, with an early warning when the largest
CSS file has less than 1 KiB of headroom.

JavaScript accounting separates ordinary chunks, deferred special-purpose
chunks, startup assets, and the full bundle total. The 215 KiB ordinary-chunk
ceiling excludes the isolated Mermaid renderer and configured locale catalogs.
A locale catalog must match `assets/<locale>-<nonempty-suffix>.js`; each
configured locale may produce one deferred chunk, with at most 20 locale chunks
overall and a 300 KiB ceiling per chunk. Locale chunks remain forbidden in the
startup asset set. Total JavaScript accounting includes ordinary, deferred, and
startup assets for reporting while enforcement stays on the category-specific
limits.

CI builds the selected checkout and the exact preflight base with the same
installed Node, Vite, and dependencies. The temporary base's CSS sidecars are
normalized through the candidate's pinned compressor before comparison. The
report identifies both revisions and the toolchain. There is no manually updated
CSS baseline, and the cumulative ceilings still bound a series of small changes.

Run the same comparison locally after installing dependencies:

```bash
pnpm ui:check-performance:base <base-commit-sha>
```

To enforce absolute budgets on an existing build, run `pnpm ui:check-performance`.
Use `--base-dist <directory>` to compare with an already-built base, or
`--report-only` to report violations without failing. Missing or malformed build
artifacts remain errors in report-only mode.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
