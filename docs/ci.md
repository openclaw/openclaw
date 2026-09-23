---
summary: "CI job graph, scope gates, release umbrellas, and local command equivalents"
title: "CI pipeline"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging a failing GitHub Actions check
  - You are coordinating a release validation run or rerun
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
---

This page is an index. CI is documented on nine pages, one per reader
job. Open the page that matches your task.

For the published-upgrade regression gate, see [selection and routing](/ci/scope-and-routing#scope-and-routing), [runner budgets](/ci/capacity#runner-registration-budget), and [Package Acceptance baselines](/ci/release-validation#suite-profiles). Weekly validation is listed under [Update Migration](/ci/scheduled-workflows#update-migration).

Docs-only `main` pushes skip CI and cache warming. The cache warmer publishes dependencies independently of long builds and maintains a bounded hosted seed in hybrid mode. Every admitted canonical `main` run exercises one published-driver × candidate Docker upgrade; ordinary manual/release validation adds the other five Docker seed lanes. QA Smoke, real-Gateway browser checks, and named process proofs retain their selected `main` coverage and manual/release validation. Pull requests and exact-head PR fallback dispatches retain unit, boundary, build, and mocked-Gateway coverage. Windows retains its complete inventory across five measured file shards. See [scope selection](/ci/scope-and-routing/selection) and [capacity](/ci/capacity#owner-path-and-release-coverage) for the coverage trade-off.

Core-test-only PRs use targeted type checks only when every selected test exists in the checkout. Deleting a core test keeps the full type-check plan, including the existing core stripes on GitHub and hybrid profiles.

Core lint discovers separate source and UI TypeScript projects, retaining shared ambient declarations and imported dependencies. The source project also includes `src/**/*.test-support.cjs`; unrelated JavaScript files are not added as roots. See [local checks](/ci/local-proof#local-equivalents).

Android native resource preparation uses the Mermaid renderer's filtered dependency install, including optional build tooling. Pnpm retains root dependencies but omits unrelated plugin packages; Gradle still builds the assets and runs the selected native tests and lint. Historical targets keep their compatibility path.

macOS Swift CI runs the app and independent package suites in separate [native phases](/ci/pipeline#macos-swift-phases), retaining every test and the existing concurrency and timeout limits.

Native test builds retain coverage and source-line backtraces while omitting IDE indexes and full debugger type metadata. Local development builds keep their normal debug settings.

Short hybrid jobs use a [40-row base threshold and 45-row hosted admission limit](/ci/capacity#bounded-hybrid-hosted-offload), with unchanged coverage and Blacksmith fallback when optional work does not fit.

Additional hybrid check offloads require [fresh hosted assignment evidence](/ci/runners#hybrid-hosted-assignment-guard). Eligible PRs can move five measured checks; main pushes can also move lint and central types within the same hosted row limit. Artifact builds retain Blacksmith because their measured hosted tail leaves no room for the [15-minute routing objective](/ci/routing-costs).

Windows keeps its complete explicit test inventory in five [measured project-aligned shards](/ci/runners#runner-backend-modes), sharing each small project's setup within one job.

Real-Gateway browser checks use [job budgets matched to their selected runner](/ci/runners#blacksmith-runner-capacity).

Control UI CI installs the Chromium revision pinned by Playwright even when the browser cache misses. Current targets use the installer's `--require-playwright-chromium` mode; historical targets retain their existing installer. Browser startup diagnostics include provider, page, WebSocket, and Chromium process events to diagnose a session-readiness timeout even when it is reported only after unrelated unit work finishes.

Browser extension CI launches the installed, patched Chrome MCP dependency directly.

Build, QA and test orchestration restore the same [protected Node compile cache](/ci/scope-and-routing/node-test-lanes). The trusted warmer populates build tools before collecting test imports, including the same seven Control UI seed files on Node and the pinned Bun fork in both Linux cache backends; ordinary CI remains restore-only.

In-process Gateway test configs use [exclusive plan admission within existing packed jobs](/ci/capacity#measured-shard-weights).

Changed-extension PR jobs use [measured fallback rates and a 300-second packing budget](/ci/capacity#runner-registration-budget) within the landed 90-row compact, 130-row PR and 70-row push caps.

Compact planning reserves the actual appended plugin rows before applying those
Node matrix caps, allowing existing hosted tooling compaction to use the
remaining capacity.

Roomy serial Blacksmith Node jobs use [measured Vitest worker sizing](/ci/capacity#vitest-worker-sizing), with existing hosted, frozen-target, and overlapping-plan limits.

Source-only Linux Node shards can reuse content-validated compiled workers from the protected warmer; [fixed preparation costs](/ci/capacity#fixed-job-preparation) remain separate from test execution and runner capacity.

Vitest transform-cache fingerprints exclude the generated `.ci-harness` checkout so CI consumers and the protected warmer hash the same source inputs. Node bytecode caching remains enabled for ordinary Vitest runs; Vitest owns the worker-level coverage safeguard described in [local testing](/reference/test/local#core-commands).

Transform keys also include each project's dependency optimizer directory. This
prevents cached UI imports from mixing separate projects' Lit instances when a
focused run and a full run share the persistent cache.

Linux PR tests use Bun for the measured compatible unit lanes and Control UI
Vitest job, with a targeted CSS-tokenizer optimizer workaround. Full Release Validation
keeps their Node coverage and runs them on Bun too; see [test runtime selection](/ci/pipeline#test-runtime-selection).

Full Release Validation's exact-target UI job retains the current three native
shards for both runtimes. Historical compatibility targets keep their original
unsharded package command; see [UI job budgets](/ci/scope-and-routing/job-budgets).

Auto-reply reply tests run files in parallel with two workers per compact group. Their planner uses separate parallel timing identities; until those have measurements, serial group costs are divided by the effective worker count, with single-file groups retaining their full cost.

The measured Gateway isolated/database-worker cohort uses at most eight workers
on those hosts with at least 28 GiB total memory; other packed groups retain
their existing caps.

Commands tests share the existing worker budget across independent files. The
Doctor session SQLite cases are split by operation while preserving the complete
repair and recovery coverage; see [shard weights](/ci/capacity#measured-shard-weights).

The complete [startup corpus](/ci/pipeline) uses eight state test files so existing workers can share its release/config matrix. Its explicit fallback prepares the runtime once and uses up to four workers, capped by available CPU parallelism; historical frozen targets retain their legacy process layout with CPU-bounded admission.

| Page                                                           | Read it when                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [CI pipeline jobs](/ci/pipeline)                               | The job table, the fail-fast order, and the Control UI size budgets.                                                |
| [Watch a CI run](/ci/watching-runs)                            | Wait on one pull request head, recover a stuck run, and pass the evidence gate.                                     |
| [CI checkout ownership](/ci/checkout)                          | Shared checkout anchors, fetch retry budgets, and trusted action policy.                                            |
| [CI scope and routing](/ci/scope-and-routing)                  | Why a job did or did not run: changed-scope detection and manual dispatch.                                          |
| [CI runner classes](/ci/runners)                               | Trust-based runner routing, preflight queue recovery, Blacksmith classes, and runner backend modes.                 |
| [CI capacity and shard weights](/ci/capacity)                  | The runner registration budget and the measured timings behind shard packing.                                       |
| [Release validation workflows](/ci/release-validation)         | Full Release Validation, live and E2E shards, Package Acceptance, install smoke, Docker E2E, and Plugin Prerelease. |
| [Scheduled and maintenance workflows](/ci/scheduled-workflows) | OpenClaw Performance, QA Lab, CodeQL, the maintenance jobs, and ClawSweeper activity forwarding.                    |
| [Local checks and Testbox](/ci/local-proof)                    | Reproduce a lane locally, keep the shrink-only ratchets, and run Crabbox or Testbox proof.                          |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/ci#pipeline-overview` still resolves. Each entry points at the page that now holds the content.

- <a id="pipeline-overview" />[Pipeline overview](/ci/pipeline#pipeline-overview)
- <a id="fail-fast-order" />[Fail-fast order](/ci/pipeline#fail-fast-order)
- <a id="control-ui-size-budgets" />[Control UI size budgets](/ci/pipeline#control-ui-size-budgets)
- <a id="watching-pull-request-ci" />[Watching pull request CI](/ci/watching-runs#watching-pull-request-ci)
- <a id="recover-an-existing-pr-run-first" />[Recover an existing PR run first](/ci/watching-runs#recover-an-existing-pr-run-first)
- <a id="pr-context-and-evidence" />[PR context and evidence](/ci/watching-runs#pr-context-and-evidence)
- <a id="checkout-ownership" />[Checkout ownership](/ci/checkout#checkout-ownership)
- <a id="scope-and-routing" />[Scope and routing](/ci/scope-and-routing#scope-and-routing)
- <a id="measured-shard-weights" />[Measured shard weights](/ci/capacity#measured-shard-weights)
- <a id="clawsweeper-activity-forwarding" />[ClawSweeper activity forwarding](/ci/scheduled-workflows#clawsweeper-activity-forwarding)
- <a id="manual-dispatches" />[Manual dispatches](/ci/scope-and-routing#manual-dispatches)
- <a id="windows-testbox-probe" />[Windows Testbox Probe](/ci/scope-and-routing#windows-testbox-probe)
- <a id="runners" />[Runners](/ci/runners#runners)
- <a id="blacksmith-runner-capacity" />[Blacksmith runner capacity](/ci/runners#blacksmith-runner-capacity)
- <a id="runner-backend-modes" />[Runner backend modes](/ci/runners#runner-backend-modes)
- <a id="runner-registration-budget" />[Runner registration budget](/ci/capacity#runner-registration-budget)
- <a id="surface-ratchets" />[Surface ratchets](/ci/local-proof#surface-ratchets)
- <a id="local-equivalents" />[Local equivalents](/ci/local-proof#local-equivalents)
- <a id="openclaw-performance" />[OpenClaw Performance](/ci/scheduled-workflows#openclaw-performance)
- <a id="vitest-paired-benchmark" />[Vitest paired benchmark](/ci/scheduled-workflows#vitest-paired-benchmark)
- <a id="full-release-validation" />[Full Release Validation](/ci/release-validation#full-release-validation)
- <a id="live-and-e2e-shards" />[Live and E2E shards](/ci/release-validation#live-and-e2e-shards)
- <a id="package-acceptance" />[Package Acceptance](/ci/release-validation#package-acceptance)
- <a id="jobs" />[Jobs](/ci/release-validation#jobs)
- <a id="candidate-sources" />[Candidate sources](/ci/release-validation#candidate-sources)
- <a id="suite-profiles" />[Suite profiles](/ci/release-validation#suite-profiles)
- <a id="legacy-compatibility-windows" />[Legacy compatibility windows](/ci/release-validation#legacy-compatibility-windows)
- <a id="examples" />[Examples](/ci/release-validation#examples)
- <a id="install-smoke" />[Install smoke](/ci/release-validation#install-smoke)
- <a id="local-docker-e2e" />[Local Docker E2E](/ci/release-validation#local-docker-e2e)
- <a id="tunables" />[Tunables](/ci/release-validation#tunables)
- <a id="reusable-livee2e-workflow" />[Reusable live/E2E workflow](/ci/release-validation#reusable-live/e2e-workflow)
- <a id="release-path-chunks" />[Release-path chunks](/ci/release-validation#release-path-chunks)
- <a id="plugin-prerelease" />[Plugin Prerelease](/ci/release-validation#plugin-prerelease)
- <a id="qa-lab" />[QA Lab](/ci/scheduled-workflows#qa-lab)
- <a id="codeql" />[CodeQL](/ci/scheduled-workflows#codeql)
- <a id="security-categories" />[Security categories](/ci/scheduled-workflows#security-categories)
- <a id="platform-specific-security-shards" />[Platform-specific security shards](/ci/scheduled-workflows#platform-specific-security-shards)
- <a id="critical-quality-categories" />[Critical Quality categories](/ci/scheduled-workflows#critical-quality-categories)
- <a id="maintenance-workflows" />[Maintenance workflows](/ci/scheduled-workflows#maintenance-workflows)
- <a id="dependency-audit" />[Dependency Audit](/ci/scheduled-workflows#dependency-audit)
- <a id="docs-agent" />[Docs Agent](/ci/scheduled-workflows#docs-agent)
- <a id="duplicate-prs-after-merge" />[Duplicate PRs After Merge](/ci/scheduled-workflows#duplicate-prs-after-merge)
- <a id="local-check-gates-and-changed-routing" />[Local check gates and changed routing](/ci/local-proof#local-check-gates-and-changed-routing)
- <a id="config-baseline-count-ratchet" />[Config baseline count ratchet](/ci/local-proof#config-baseline-count-ratchet)
- <a id="testbox-validation" />[Testbox validation](/ci/local-proof#testbox-validation)

## Related

- [Tests](/reference/test)
- [Scripts](/help/scripts)
- [Maturity scorecard](/maturity/scorecard)
- [Install overview](/install)
- [Release channels](/install/development-channels)
