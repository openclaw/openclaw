# Phase: entry-auth-gate — Plan

**Planned:** 2026-04-18
**Research:** `.planning/phases/entry-auth-gate/RESEARCH.md`
**Branch:** `refactor/entry-auth-gate`

## Goal

Replace the lexical argv-sniff at `src/entry.ts:22-30` with a structured, command-owned manifest so renaming, aliasing, or inserting an option inside the `secrets audit` token pair cannot silently drop the `OPENCLAW_AUTH_STORE_READONLY=1` guarantee. The env variable must continue to be set before any CLI module with a module-load-time env capture could observe an unset value, the failure mode on drift must convert from "silent security regression" to "loud test failure" caught in CI, and cold-path module resolution cost for the entry point must not increase.

## Preconditions

- Branch `refactor/entry-auth-gate` is checked out and clean (no unstaged edits to `src/entry.ts` or `src/cli/secrets-cli.ts`).
- `pnpm install` has been run; `pnpm tsgo` and `pnpm check` are green on the base commit so drift introduced by this phase is attributable.
- No in-flight PR is renaming the `secrets audit` command — if there is one, either wait for it to land or coordinate the manifest entry at the same time.

## Approach summary

Approach A from the research (see RESEARCH.md §Recommendation, lines 101–103). Export a `READ_ONLY_AUTH_COMMAND_PATHS` manifest from a new sibling module next to `src/cli/secrets-cli.ts`, import it from `src/entry.ts`, and iterate it instead of hard-coding the `["secrets", "audit"]` pair inline. A regression-guard test imports both the manifest and the Commander tree and asserts every manifest entry resolves to a real registered subcommand path; any rename without a matching manifest edit fails the test. The manifest lives in its own file — not inside `secrets-cli.ts` — so `entry.ts` does not transitively drag Commander, the secrets subcli action bodies, or their imports into the cold path, preserving the lazy-subcli design at `src/cli/program/register.subclis-core.ts:206-210` (RESEARCH.md Q1, line 45). Pre-parse env timing is preserved as defense-in-depth per RESEARCH.md Q2 (lines 55–56); both env consumers read at call-time today, but future consumers might not.

## Task ordering and dependencies

Tasks are totally ordered. Later tasks depend on earlier ones: tasks 2 and 3 depend on task 1 (manifest file must exist); task 4 depends on task 1 (import target); task 5 depends on task 4 (tests the rewritten function); task 6 depends on task 1 (imports the manifest); task 7 is a cleanup check on task 4; task 8 depends on all prior. Tasks 4 and 6 must land in the same commit — task 4 without task 6 removes the old literal guard and provides no replacement belt against rename drift.

## Task list

### 1. Add the manifest module

- **Files:** `src/cli/secrets-cli.read-only-paths.ts` (new file, ~15 lines).
- **Change:** Export `READ_ONLY_AUTH_COMMAND_PATHS: readonly (readonly string[])[] = [["secrets", "audit"]] as const`. No Commander import, no other imports. Add a top-of-file JSDoc block that:
  1. Names the two binding sites — `src/entry.ts` (consumer) and `src/cli/secrets-cli.ts:84` (registration site).
  2. States the invariant: every entry must resolve to a registered Commander subcommand path, enforced by `secrets-cli.read-only-paths.test.ts`.
  3. Documents the option-stripping behavior of the entry-side matcher (tokens starting with `-` are filtered before matching) so a future maintainer does not add a path component that begins with `-`.
- **Verify:** `pnpm tsgo` passes. `Grep` for `READ_ONLY_AUTH_COMMAND_PATHS` shows exactly one declaration in this file.

### 2. Re-export manifest from the secrets subcli for co-location signal

- **Files:** `src/cli/secrets-cli.ts` (near top, after existing imports, before `registerSecretsCli`).
- **Change:** Add `export { READ_ONLY_AUTH_COMMAND_PATHS } from "./secrets-cli.read-only-paths.js";`. This surfaces the manifest in the same file as `registerSecretsCli` so a reviewer opening this module sees both the registration and the co-located invariant reference. Do NOT move the array literal here — keeping the source in the sibling module is what lets `entry.ts` import the manifest without pulling the subcli's Commander action bodies into cold-path module resolution.
- **Verify:** `pnpm tsgo` passes. A test import `import { READ_ONLY_AUTH_COMMAND_PATHS } from "./secrets-cli.js"` resolves to the same reference as the sibling-module import.

### 3. Add a local comment anchor at the audit command definition

- **Files:** `src/cli/secrets-cli.ts:84` (immediately above `secrets.command("audit")`).
- **Change:** One-line comment: `// SECURITY: renaming/aliasing this command requires updating READ_ONLY_AUTH_COMMAND_PATHS in ./secrets-cli.read-only-paths.ts — the regression test in secrets-cli.read-only-paths.test.ts enforces this binding.` This is the visible footgun guard for any maintainer editing the command name without reading the sibling module.
- **Verify:** `Grep` for `READ_ONLY_AUTH_COMMAND_PATHS` in `src/cli/secrets-cli.ts` returns at least two hits: the re-export line from task 2 and this comment anchor.

### 4. Replace the argv-sniff in `entry.ts` with a manifest-driven check

- **Files:** `src/entry.ts` (new import near the existing import block at lines 1–15; rewrite of `shouldForceReadOnlyAuthStore` at lines 22–30).
- **Change:**
  1. Add `import { READ_ONLY_AUTH_COMMAND_PATHS } from "./cli/secrets-cli.read-only-paths.js";`. Import from the sibling module directly, NOT from `./cli/secrets-cli.js` — the re-export in task 2 is a reviewer aid, not an import path for the cold-path entry point.
  2. Rewrite `shouldForceReadOnlyAuthStore(argv: string[]): boolean` to build the filtered-token array once (`argv.slice(2).filter(t => t.length > 0 && !t.startsWith("-"))`), then for each path in the manifest scan the filtered tokens for an adjacent, in-order run matching the path. Return `true` on the first match; `false` otherwise.
  3. Preserve the existing call site semantics at `src/entry.ts:60-62` — no signature change, no return-type change, no async.
- **Verify:** `pnpm tsgo` passes. Task 5 and 7 assert behavior and the absence of inline literals respectively.

### 5. Unit test: positive and negative argv cases

- **Files:** `src/entry.read-only-auth.test.ts` (new file; keep `src/entry.test.ts` untouched to avoid churn in its existing fixtures).
- **Change:** Export `shouldForceReadOnlyAuthStore` from `entry.ts` with a `/** @internal */` JSDoc if it is not already exported (current file does not export it). Tests:
  - **Positive:** `expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "audit"])).toBe(true)`.
  - **Positive with option between tokens:** `expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "--json", "audit"])).toBe(true)` — locks in the option-stripping behavior.
  - **Positive trailing option:** `expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "audit", "--check"])).toBe(true)`.
  - **Negative same parent:** `expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "list"])).toBe(false)`.
  - **Negative lone tokens:** `secrets` alone and `audit` alone both return `false`.
  - **Negative empty argv:** `[]` and `["node", "openclaw"]` both return `false`.
  - **Full-gate integration:** one test that sets `process.argv = ["node", "openclaw", "secrets", "audit"]`, calls the gate, and on `true` sets `process.env.OPENCLAW_AUTH_STORE_READONLY = "1"`; asserts the env is `"1"`. Restore `process.env` and `process.argv` in `afterEach`.
- **Verify:** `pnpm test src/entry.read-only-auth.test.ts` — all cases pass.

### 6. Regression-guard test: manifest ↔ registered command tree

- **Files:** `src/cli/secrets-cli.read-only-paths.test.ts` (new file).
- **Change:** The test:
  1. Imports `READ_ONLY_AUTH_COMMAND_PATHS` from `./secrets-cli.read-only-paths.js` and `registerSecretsCli` from `./secrets-cli.js`.
  2. Constructs a fresh `new Command()` from Commander, calls `registerSecretsCli(program)`.
  3. For each path in the manifest, walks down `program.commands.find(c => c.name() === path[0])`, then `.commands.find(c => c.name() === path[1])`, etc. If any step returns `undefined`, fail with a message naming the drifted path (`Manifest entry ["secrets","audit"] has no matching Commander subcommand — likely rename at src/cli/secrets-cli.ts:84. Update READ_ONLY_AUTH_COMMAND_PATHS.`).
  4. Asserts the manifest is non-empty (`expect(READ_ONLY_AUTH_COMMAND_PATHS.length).toBeGreaterThan(0)`) — without this, an accidentally emptied manifest would silently pass.
  5. Asserts each path has length ≥ 1.
- **Verify:** `pnpm test src/cli/secrets-cli.read-only-paths.test.ts`. In a scratch branch, rename `.command("audit")` to `.command("audit2")` and confirm the test fails with the expected message; revert.

### 7. Confirm no inline string literal remains in the gate

- **Files:** `src/entry.ts` (inspection of `shouldForceReadOnlyAuthStore` body after task 4).
- **Change:** Review the rewritten function body and confirm the only string data flowing into the match comes from `READ_ONLY_AUTH_COMMAND_PATHS`. The literals `"secrets"` and `"audit"` must not appear inside the function. The `-` prefix check in the filter is fine (structural argv handling, not a path literal).
- **Verify:** `Grep` for `"secrets"` and `"audit"` in `src/entry.ts` returns no hits inside `shouldForceReadOnlyAuthStore`. `pnpm check` passes.

### 8. Land verification

- **Files:** none (verification step).
- **Change:** Run the landing gates per CLAUDE.md. `pnpm build` is required because `src/entry.ts` is the CLI entrypoint and this change touches module boundaries / lazy-loading surface.
- **Verify:**
  1. `pnpm check` — green.
  2. `pnpm test` — green (scoped tests from tasks 5 and 6 pass alongside the full suite).
  3. `pnpm build` — green, no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings referencing `secrets-cli.read-only-paths`.
  4. `pnpm check:import-cycles` and `pnpm check:madge-import-cycles` — green (the new import is one-directional: `entry.ts` → `secrets-cli.read-only-paths.ts`, no cycle possible).

## Files touched summary

- `src/cli/secrets-cli.read-only-paths.ts` — **new**, exports `READ_ONLY_AUTH_COMMAND_PATHS` manifest and JSDoc invariant documentation (task 1).
- `src/cli/secrets-cli.read-only-paths.test.ts` — **new**, regression-guard test that walks the Commander tree and asserts every manifest entry resolves to a registered subcommand (task 6).
- `src/cli/secrets-cli.ts` — **edit**, one-line re-export of the manifest (task 2) and one-line SECURITY comment above `.command("audit")` at line 84 (task 3).
- `src/entry.ts` — **edit**, one new import and a rewrite of `shouldForceReadOnlyAuthStore` at lines 22–30 to iterate the manifest (task 4); `/** @internal */` export added if not already exported (task 5 dependency).
- `src/entry.read-only-auth.test.ts` — **new**, positive and negative argv unit tests plus full-gate integration test (task 5).

## Goal-backward verification plan

The phase goal is: `OPENCLAW_AUTH_STORE_READONLY=1` iff the CLI is invoked against a command path declared in the manifest, AND renaming a declared command without updating the manifest fails CI, AND entry-point cold-path cost is unchanged. End-to-end checks that prove the goal (not just per-task completion):

1. **Positive argv test** (task 5) — fakes `process.argv = ["node", "openclaw", "secrets", "audit"]`, runs the gate, asserts `process.env.OPENCLAW_AUTH_STORE_READONLY === "1"`. Directly models the production invocation path from `src/entry.ts:60-62`.
2. **Negative argv test** (task 5) — fakes `process.argv = ["node", "openclaw", "secrets", "list"]`, runs the gate, asserts `process.env.OPENCLAW_AUTH_STORE_READONLY` is not set by the gate. Proves the gate is not a blanket trigger on the `secrets` parent.
3. **Option-between-tokens test** (task 5) — fakes `process.argv = ["node", "openclaw", "secrets", "--json", "audit"]`, asserts the gate still fires. Locks in the option-stripping behavior so a future "fix" to the filter does not silently narrow coverage.
4. **Manifest-matches-command-tree test** (task 6) — imports `READ_ONLY_AUTH_COMMAND_PATHS`, constructs a program, runs `registerSecretsCli`, walks each path. Rename without manifest update → test fails with a targeted error message. This is the belt that converts silent security regression into a red CI build.
5. **Cold-path bundle check** — after `pnpm build`, spot-check that `dist/entry.js` (or the bundled entry artifact) does not statically reference `registerSecretsCli` or other `secrets-cli.ts` action-body identifiers. Use `Grep` over the built artifact for `registerSecretsCli` and `runSecretsAudit` — zero hits expected in the entry bundle. This proves the manifest module stayed lightweight and entry.ts did not accidentally pull the subcli eagerly.
6. **Live CLI smoke** — after `pnpm build`, run `node dist/entry.js secrets audit --check --json` in a scratch dir with no creds. Spot-check via `src/agents/auth-profiles/store.ts:230` that no credential-mutation path fires (observational; not a new test).

## Success criteria

The phase is done when all of the following hold simultaneously:

- `shouldForceReadOnlyAuthStore` in `src/entry.ts` contains no `"secrets"` or `"audit"` string literals; all token data flows from `READ_ONLY_AUTH_COMMAND_PATHS`.
- `src/cli/secrets-cli.read-only-paths.ts` exists, is imported exactly once by `src/entry.ts` and once by `src/cli/secrets-cli.ts` (re-export), and has no third consumer.
- Tests in tasks 5 and 6 pass on the current tree and fail deterministically on a `.command("audit")` → `.command("audit2")` rename without a matching manifest update.
- `pnpm check`, `pnpm test`, and `pnpm build` are green.
- No new `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings or `check:madge-import-cycles` failures.

## Alternatives considered

- **Approach B (Commander dry-parse pre-dispatch).** Rejected: RESEARCH.md lines 89–94 — requires either full program construction on the cold path (breaks the lazy-subcli design at `src/cli/program/register.subclis-core.ts:206-210`) or a hand-rolled argv walker that mirrors Commander's option grammar. Cost and maintenance burden exceed the structural gain over A.
- **Approach C (lazy-read consumers + preAction metadata flag).** Rejected for this phase; viable as a follow-up. RESEARCH.md lines 96–99 — cleanest long-term coupling, but loses pre-import env timing as defense-in-depth and touches three files plus a new hook extension in `src/cli/program/preaction.ts`. Scope creep vs A's two-file surgical change. If the repo later adopts a broader command-metadata pattern, promote A's manifest into a Commander property read by the preAction hook.

## Risks and mitigations

- **Defense-in-depth: add a preAction hook too?** RESEARCH.md Q2 (lines 49–56) confirms both env consumers read `process.env` at function-call time, so a preAction hook in `src/cli/program/preaction.ts` would work equivalently. **Recommendation: do NOT add it in this phase.** Two gates for the same signal doubles the drift surface (manifest + hook walker) and the regression-guard test in task 6 already makes manifest drift loud in CI. The existing pre-parse gate in `entry.ts` remains the defense-in-depth layer against a future module-load-time env capture. If a future phase adopts Approach C, the preAction hook replaces — not augments — the entry-time check; plan that migration explicitly rather than letting both coexist silently.
- **Test coverage gap before this phase.** Reviewing `src/cli/secrets-cli.test.ts` and `src/entry.test.ts`: no existing test today would catch a rename of `.command("audit")` combined with a missed `entry.ts` update. The regression-guard test in task 6 is the entire belt; without it, Approach A is strictly no better than the status quo. Task 6 is therefore non-negotiable and must land in the same commit as task 4.
- **Manifest import path must bypass the lazy subcli.** Task 1 puts the manifest in `secrets-cli.read-only-paths.ts` (no Commander import, no transitive pulls) precisely so `entry.ts` does not eagerly resolve the full `secrets-cli.ts` module — which would regress the lazy-load design at `register.subclis-core.ts:206-210`. Do not "simplify" by moving the manifest into `secrets-cli.ts` as an originating export. The cold-path bundle check in goal-backward step 5 enforces this at build time.
- **Entry-side import-surface creep.** Every new import added to `src/entry.ts` is cold-path cost on every CLI invocation. Task 4 adds exactly one new import (`secrets-cli.read-only-paths.js`) — a pure data module with no dependencies. Future read-only-command additions should reuse this single import by extending the array, not by adding new per-command imports.
- **Option-stripping behavior is a documented constraint.** The filter strips any token starting with `-`. If a future manifest entry includes a path component that legitimately starts with `-` (Commander subcommand names conventionally don't), the filter would hide it and the match would silently fail. The JSDoc on the manifest file (task 1) documents this so the next maintainer has a fighting chance.
- **Import from `.js` extension in TypeScript.** Per `package.json` ESM conventions in this repo, TypeScript source imports use the `.js` extension pointing to the compiled output. Both the manifest module filename and all task-specified imports follow this convention (`./secrets-cli.read-only-paths.js`). No CommonJS fallback needed.

## Out of scope

- Changing consumer-side env read timing in `src/agents/auth-profiles/store.ts:230` or `src/agents/pi-model-discovery.ts:155-158`.
- Adding a `preAction` hook for read-only enforcement (Approach C).
- Migrating other security-sensitive env gates (none exist today; this is the only argv-sniff of its kind).
- Refactoring `src/cli/program/subcli-descriptors.ts` to carry command metadata.
- Any change to `runSecretsAudit`, the audit business logic, or the audit command's options.
- Extending the manifest to cover other commands — add only `["secrets", "audit"]` in this phase; new entries require their own security review.

## Commit and landing

Single commit per repo convention (`scripts/committer`). Message: `entry: replace argv-sniff with command-owned read-only manifest`. Include all five files (manifest, manifest test, secrets-cli.ts re-export + comment, entry.ts import + rewrite, entry-side test) in one commit so tasks 4 and 6 cannot be split across commits. No changelog entry required — this is an internal security-hardening refactor with no user-facing behavior change (see `.claude/rules/testing-guidelines.md` §Changelog).

## Rollback

Revert the commit. The manifest module, the re-export in `secrets-cli.ts`, the comment anchor, and the import in `entry.ts` are the entire surface; reverting restores the inline literal argv-sniff at `src/entry.ts:22-30` with no residual state, no migrations, no config changes.
