---
summary: "Behavioral integration proof, test value and cost, and regression authoring"
title: "Writing and adding tests"
read_when:
  - You are writing a new test
  - You are adding a regression for a provider bug
---

## Prove behavior at the owning boundary

Prove a caller-visible contract through its production owner with fixed external
I/O fixtures and independent expected values. Prefer focused integration tests
and independent unit contracts over mocked internal decisions or whole-product
boots. Name the credible regression and what the test cannot prove.

Work in vertical slices: failing behavior, coherent repair, passing proof.
Regressions must fail on the original defect, not fixture setup; report unavailable
baseline proof. Refactor under green tests and preserve distinct contracts when
consolidating coverage. Use synthetic content and keep credentials out of captures.

Apply the [test value gate](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md)
and [proof policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#proof-policy).
For requests, paid calls, recovery, defaults, or performance claims, read the
[scenario contracts](/help/testing/boundary-scenarios#scenario-contracts) before
changing code or proof. Too many private controls suggest fragmented ownership,
not a need for test-only exports.

## Cost budget

Measure every new or changed test file with
`pnpm test <file> --maxWorkers=1`; report wall time and CI seconds once available;
PRs state both.

- Seconds-long tests must prove a contract no cheaper layer can. Long end-to-end
  compositions belong in the release-only tier.
- Target under 5 seconds of test time per file. Above 30 seconds, explain the
  contract and why no cheaper layer proves it.
- Split files exceeding planner job budgets by owner, or consider `RELEASE_ONLY_*`
  in `scripts/lib/ci-node-test-plan.mts`. Weigh PR risk against release detection;
  keep coverage without duplicate release tests. Preserve assigned configs and
  process/timer policies; product E2E/live stays separate. See
  [maintainer-tooling routing](/ci/scope-and-routing/node-test-lanes).
- Inject clocks; do not add real timers, sleeps, or polling. Claim ports through
  `src/test-utils/port-claims.ts`, isolate each file's state, and reuse suite-level
  Gateway/process fixtures; never boot one per test when a suite-level fixture
  exists. Import narrow APIs, not broad barrels. Fix shared state; do not add
  serial configs or worker pins.
- Async E2E waits: produced state, never action return.
- For compiled subprocesses and legacy timeout helpers, follow the
  [collection/preload and timeout migration recipes](/help/testing/fixtures#compiled-subprocesses-and-timeout-helpers).

## Test Temp Directories

Use [temporary directory and executable fixture recipes](/help/testing/fixtures#test-temp-directories)
for shared cleanup, bare-directory exceptions, and close-on-exec copies.

## Agent reliability evals (skills)

For skill selection, compliance, and multi-turn workflow evals, use the
[fixture guide](/help/testing/fixtures#agent-reliability-evals-skills).

## Module mocks and export completeness

Follow the [mock recipe](/help/testing/fixtures#module-mocks-and-export-completeness)
for export preservation, state-isolating mocks, annotations, and the shrinking baseline.

## Raw SQLite state access

Before raw database reads or file snapshots, follow the
[async close contract](/help/testing/fixtures#raw-sqlite-state-access).

<a id="skills-watchers" />

## Skills discovery

Close the background worker and isolate passive refresh as described in
[discovery cleanup](/help/testing/fixtures#skills-discovery).

## Flake triage

Follow the canonical
[test failure policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#test-failure-policy).
Reproduce the original shard order before running alone; order-only failures
usually mean earlier-file shared-state leaks. Classify fixture state, missing
completion signals, and product races. Repair the producer. If a removal caused
the red, read its PR's accepted tradeoffs before restoring it. Choose repeat
counts for the reproduced failure mode, not a fixed clean-run quota.

The Control UI's non-isolated `unit` project reports per-test DOM leaks with
`[ui-test-leak]` after fixture teardown. Reports name the test and leftover body
children, body or HTML styles/classes, pointer captures, repository-owned global
listeners, or fake timers. Node-environment tests still check fake timers. The
guard currently reports without failing; fix the fixture or resource owner
rather than adding an ignore list. Use `mountSolid` for owned render roots,
dispose non-rendering owners, and restore document-wide state changed by a
fixture. A unit report does not cover the separate real-browser project.

## Adding regressions (guidance)

Pass bounded synthetic inventories and fixed timing through real planners for
capacity bugs. Preserve coverage, ownership, and execution-budget assertions;
keep real-checkout inventory coverage in its existing integration tests.

For live provider bugs, prefer a CI-safe regression at the smallest production
composition reaching the defect: real adapters with captured requests, Gateway
integration for session/history/tool pipelines, or independent parser unit
contracts. Keep inherently live-only checks narrow and opt-in.

New `includeInPlan` SecretRef families in `src/secrets/target-registry-data.ts`
need classification in `src/secrets/exec-secret-ref-id-parity.test.ts` so sampled
traversal-segment rejection cannot silently skip them.
