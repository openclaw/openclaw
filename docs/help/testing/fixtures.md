---
summary: "Temporary directories, module mocks, database cleanup, watchers, and skill eval fixtures"
title: "Test fixture recipes"
read_when:
  - You need temporary files, module mocks, database teardown, or skill watchers in a test
  - You are building skill reliability evals
---

Use these recipes for the fixture you are changing. Follow the
[test authoring contract](/help/testing/writing-tests) for behavior and cost.

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

Start future evals with fixed inputs and mock providers:

- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Module mocks and export completeness

New first-party `vi.mock` and `vi.doMock` factories should preserve the real
module's exports when the fixture only needs to override a few functions:

```ts
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  start: vi.fn(),
}));
```

Use pass-through for **export completeness** only. `importOriginal` and
`vi.importActual` can return a separate module instance for stateful singletons;
they do not guarantee shared state or lifecycle identity. Keep a closed mock when
isolating real state or initialization is the fixture's purpose, and explain that
contract on the line immediately above the mock call:

```ts
// mock-isolation: Keep the database and process-wide cache outside this fixture.
vi.mock("./runtime.js", () => ({ start: vi.fn() }));
```

`pnpm check:test-mock-exports` checks literal first-party module registrations,
including relative, workspace-package, and TypeScript-path aliases. Factories
without a recognizable real-module return/spread need the annotation, including
indirect factories the syntax check cannot prove. Existing unannotated factories
have an exact source-target and token-fingerprint baseline; new or changed factories cannot borrow
another site's allowance. After removing or annotating existing factories, run
`pnpm check:test-mock-exports --prune` to shrink that baseline. This guard runs
with the existing CI ratchets and `check:changed`; it does not rewrite tests.

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

## Compiled subprocesses and timeout helpers

- Load compiled-subprocess declarations at collection, not within a test/hook
  deadline. Import the subject statically. Per-test reimport suites in core preload
  `src/test-utils/prepare-compiled-subprocesses.ts`; extensions use
  `import "openclaw/plugin-sdk/compiled-subprocess-testing";`.
  Add this preload only when the suite already reaches a declaration in
  `scripts/lib/vitest-worker-declarations.mts`.

Replace grandfathered `withTestTimeout`/`raceWithTimeoutResult` races with
`awaitGateBeforeSettlement(gate, operation, message)` or `withinTest(work, signal)`
from `test/helpers/promise.ts`, or fake timers through the owner's injected clock.
After removals run `pnpm check:test-timeout-race-ratchet --prune`; the per-file
baseline in `config/test-timeout-race-baseline.txt` only shrinks.
