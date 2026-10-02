---
summary: "Temp-directory rules, agent reliability eval gaps, and how to add a regression"
title: "Writing and adding tests"
read_when:
  - You are writing a new test
  - You are adding a regression for a provider bug
---

## Test Temp Directories

Use the shared helpers in `test/helpers/temp-dir.ts` for test-owned temporary
directories so ownership is explicit and cleanup stays in the test lifecycle:

```ts
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("uses a temp workspace", () => {
  const workspace = tempDirs.make("openclaw-example-");
  // use workspace
});
```

`useAutoCleanupTempDirTracker(afterEach)` intentionally exposes no manual
cleanup method - Vitest owns cleanup after each test. Older lower-level
helpers (`makeTempDir`, `cleanupTempDirs`, `createTempDirTracker`) still exist
for tests that have not migrated; avoid new usage of them and avoid new bare
`fs.mkdtemp*` calls unless a test is explicitly verifying raw temp-dir
behavior. When a bare temp dir is genuinely needed, add an auditable allow
comment with a reason:

```ts
// openclaw-temp-dir: allow verifies raw fs cleanup behavior
const workspace = fs.mkdtempSync(prefix);
```

`node scripts/report-test-temp-creations.mjs` reports new bare temp-dir
creation and new manual shared-helper usage in added diff lines, without
blocking existing cleanup styles. It follows the same test-path classification
as `scripts/changed-lanes.mjs` and skips the shared helper implementation
itself. `check:changed` runs this report for changed test paths as a
warning-only CI signal (GitHub warning annotations, not failures).

Copy fixture trees whose files a test later executes directly (stubs on `PATH`,
shebang wrappers, native binaries) with `copyTreeCloseOnExec` from
`test/helpers/close-on-exec-copy.ts`, not a recursive `fs.cpSync` without a
`filter`. On Node 24 that copy path opens files without close-on-exec, so a
child forked by another Vitest thread mid-copy keeps the file writable and a
later `execve` fails with `ETXTBSY`.

## Agent reliability evals (skills)

We already have a few CI-safe tests that behave like "agent reliability evals":

- Agent admission, run-ID responses, and abort requests through the real Gateway with a mock OpenAI provider (`src/gateway/gateway.test.ts`).
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.test.ts`).

What's still missing for skills (see [Skills](/tools/skills)):

- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?
- **Workflow contracts:** multi-turn scenarios that assert tool order, session history carryover, and sandbox boundaries.

Future evals should stay deterministic first:

- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Cost budget

CI selects tests by their owning area, so per-PR cost is paid repeatedly. Budgets,
measured with `pnpm test <file> --maxWorkers=1` on one worker:

- Target under 5 s of test time per file. Above 30 s, the PR body explains which
  contract needs that time and why no cheaper layer proves it.
- A file that needs more than its planner's per-job budget cannot share that
  budget with other files and can set its job's wall time. Split it by owner
  boundary, or consider the release-only tier (`RELEASE_ONLY_*` sets in
  `scripts/lib/ci-node-test-plan.mts`). Weigh how likely an unrelated PR is to
  break its contract and the cost of detecting that failure at release time.
  The unchanged suite can itself supply prepublication proof; an independent
  duplicate release test is not required. Slowness alone does not justify
  deleting coverage.
- The maintainer-tooling family uses `RELEASE_ONLY_TOOLING_SHARDS` and matching
  maintainer leaves in mixed fast configs: product-only PRs and main omit it,
  tooling-owner PRs select their affected files (with full-family fallback for unresolved owners), and manual CI and Full Release Validation
  retain it. Keep tests in their canonical configs, with their process and timer
  policies, so new files inherit the same owner routing. Dedicated product E2E
  and live tests remain outside this tier. See [Node test lanes](/ci/scope-and-routing/node-test-lanes).
- Use an injected clock at the owner instead of real timers, sleeps, or polling;
  claim ports through `src/test-utils/port-claims.ts`; give each file its own
  state directory; reuse suite-level Gateway and process fixtures instead of
  booting per test; import the narrow test API of a plugin or module rather than
  its full barrel. Do not add a serial Vitest config or a worker pin: fix the
  shared state that would need one.
- Load compiled-subprocess declarations (`scripts/lib/vitest-worker-declarations.mts`)
  at collection. The first such load in a Vitest invocation prepares the whole
  compiled worker generation (tens of seconds warm, minutes cold), so an
  `await import()` in a test or hook whose graph reaches a declaration spends
  that preparation inside the test or hook deadline. Import the subject
  statically; suites that re-import it per test add a side-effect import of
  `src/test-utils/prepare-compiled-subprocesses.ts` in core. Extension tests use
  `import "openclaw/plugin-sdk/compiled-subprocess-testing";` instead. Add the
  preload only to suites that already load a declaration.
- State the measured cost in the PR for every new or materially changed test
  file, and the CI seconds once the run exists.

`withTestTimeout` and `raceWithTimeoutResult` are grandfathered wall-clock races;
`check:test-timeout-race-ratchet` keeps their per-file counts in
`config/test-timeout-race-baseline.txt` shrink-only. Wait for the owned completion
signal with `awaitGateBeforeSettlement(gate, operation, message)` or
`withinTest(work, signal)` from `test/helpers/promise.ts`, or use `vi.useFakeTimers()`
through the owner's injected clock seam. After removing sites, run
`pnpm check:test-timeout-race-ratchet --prune` to shrink the baseline.

## Raw SQLite state access

`closeOpenClawStateDatabaseForTest()` closes native handles synchronously, but
worker-backed state writes (plugin state, deferred plugin migrations, and other
worker stores) keep a worker connection whose retirement only starts at that
call. Its final close checkpoints and deletes the WAL under an exclusive lock at
an arbitrary later time. Before opening the database with a raw `DatabaseSync`,
or copying, hashing, or snapshotting its files, `await
closeOpenClawStateDatabaseAsync()` (or `closeStateDatabaseForTest()` from
`src/test-utils/database-cleanup.ts`, which also clears failure latches).
Otherwise the raw connection can fail with `SQLITE_BUSY`, or the snapshot can
change underneath the test. `PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE` on
a raw connection proves that no other connection remains.

## Skills watchers

`skills.status` and skill snapshot preparation start real `@openclaw/fs-safe`
watchers. In shared-worker lanes, the non-isolated runner closes any watchers a
file leaves open and fails that file with `skills watchers failed`; otherwise
their re-armed timers land on a later file's fake clock and abort its
`vi.runAllTimersAsync()`. Close them in `afterEach` with
`closeSkillsWatchers(true)`, or set `skills.load.watch: false` when the test
does not exercise watching.

## Flake triage

A failure without a related change is a defect. Never re-run, re-push, or refresh
to get green.

1. Reproduce in the failing shard's file order first (the plan's file list is in
   the job log), then alone. Order-only failures are shared-state leaks from an
   earlier file.
2. Classify: fixture (temp state, ports, cwd, env, module singletons), ordering
   (assertion before the owned completion signal), or product (a real race).
3. Fix at the owner. Product races get a regression that fails on the original
   defect; fixture leaks are fixed in the fixture owner, not in the failing test.
4. Proof bar: 20 clean standalone runs of the file, 3 clean runs of the original
   shard, and the owner's sibling tests. Record the root cause in the PR.
5. If the owner is another lane or PR, cite that fix; it is the only reason to
   proceed on a red job.

## Adding regressions (guidance)

For inventory-growth and capacity regressions, pass bounded synthetic inventories
and fixed timing data through the real planner. Put the fixture at the capacity
boundary and preserve coverage, ownership, and execution-budget assertions. Keep
real-checkout inventory coverage in its integration tests instead of rebuilding
the growing repository plan for every synthetic variation.

When you fix a provider/model issue discovered in live:

- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)
- If it's inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug -> direct models test
  - gateway session/history/tool pipeline bug -> gateway live smoke or CI-safe gateway mock test
- SecretRef traversal guardrail:
  - `src/secrets/exec-secret-ref-id-parity.test.ts` derives one sampled target per SecretRef class from registry metadata (`listSecretTargetRegistryEntries()`), then asserts traversal-segment exec ids are rejected.
  - If you add a new `includeInPlan` SecretRef target family in `src/secrets/target-registry-data.ts`, update `classifyTargetClass` in that test. The test intentionally fails on unclassified target ids so new classes cannot be skipped silently.
