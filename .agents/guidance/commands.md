# Commands

Read when selecting install, build, formatting, lint, typecheck, or test commands. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

- Derive supported Node/Bun versions and package-manager pins from current `package.json`, `pnpm-workspace.yaml` and the selected server environment. Do not use a historical guide or memory as a version inventory. Preserve supported runtime paths.
- Package manager/runtime: repo defaults only. No swaps without approval.
- Install: `pnpm install` (keep Bun lock/patches aligned if touched). All installs and validation execute in the synchronized isolated checkout on `arxi-production`; never on the workstation.
- CLI: `pnpm openclaw ...` or `pnpm dev`; build: `pnpm build`.
- Never run the CLI as `node --import tsx src/index.ts`: tsx compiles all bundled plugins per process (~220s), the cost lands inside the agent task budget, and the run fails as a misleading `no progress ... timed out`. Use the dist-backed wrappers above. (Scoped-guide `node --import tsx scripts/*.mts` tools are fine — this rule is about the CLI entrypoint.)
- Checkout classes for the rules below: a **normal checkout** is a full clone with its own installed `node_modules` (includes harness/PR worktrees that have them); a **worktree** here means any Codex, linked, sparse, or `node_modules`-less checkout where pnpm may prompt or reconcile dependencies.
- Test commands, trusted source: use `pnpm test <path-or-filter> [vitest args...]`, `pnpm test:changed`, `pnpm test:serial`, or `pnpm test:coverage` with scope proportional to the touched contract. Execute them only in the synchronized isolated checkout on `arxi-production`. In a worktree, use `node scripts/run-vitest.mjs <path-or-filter>` when avoiding pnpm dependency reconciliation is useful. Never raw `vitest`; if unavoidable, `vitest run ...` (bare `vitest` starts watch mode and never exits). No `--repeat`; use a bounded shell loop.
- Checks/lint, trusted source: `pnpm check:changed` classifies and runs the formatting/typecheck/lint/guard plan on `arxi-production`. Lanes: `pnpm changed:lanes --json`; staged/path forms: `--staged` / `-- <files...>`. In a worktree, use `node scripts/check-changed.mjs [--staged|-- <files...>]` when avoiding pnpm dependency reconciliation is useful. Untrusted source: never run these repository-controlled classifiers on the workstation or a credential-bearing host.
- Extension tests: `pnpm test:extensions`, `pnpm test extensions`, `pnpm test extensions/<id>`.
- Typecheck: `tsgo` lanes only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`, `typecheck`, `check:types`.
- Formatting: `oxfmt`, not Prettier. Normal checkout: `pnpm format <paths>` (no `format:write` script); worktree: `node_modules/.bin/oxfmt` directly. Checks use repo wrappers (`pnpm format:*`, `scripts/run-oxlint.mjs`; full `pnpm lint:*` only when scope requires).
- SDK surface gate: `pnpm plugin-sdk:surface:check`; no `plugin-sdk:surface-report` script.
- Script implementations use TypeScript where their runtime supports `tsx`; plain-Node lifecycle, packaged, Docker, and loader closures remain JavaScript and are included in the scripts program through `allowJs`.
- Script wrappers: failing or crashed run must end with one final `[tool] FAILED (exit N)` stderr line; crash = nonzero exit. Truncated output must never read as success. Pattern: `scripts/run-oxlint.mjs`.
- Tooling crash `Cannot find module ...` right after pulling/merging main = stale `node_modules`, not a code bug. `pnpm install` first; only then debug.
- Build on `arxi-production` before push when build output, packaging, lazy/module boundaries, dynamic imports, or published surfaces can change. The synchronized remote checkout must represent the exact local working tree.
