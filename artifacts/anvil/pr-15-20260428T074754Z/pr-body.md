## Summary

Commits the 6-line `extensions/bench-reflective-dreaming/index.ts` bundler stub that's been sitting untracked since 2026-04-20.

## Why

The `bench-reflective-dreaming` plugin is `runtime: "scripts"` (real behavior in `scripts/install.mjs` + `scripts/uninstall.mjs`), but the tsdown bundler defaults to `./index.ts` when a manifested plugin has no `package.json`. The stub should have shipped with #1 (the dreaming + claude-code-bridge feature PR) or #4 (the fleet-canon prompt fix) but was missed.

## Why a real export instead of `export {}`

oxlint's `unicorn/require-module-specifiers` rule rejects `export {}` ("Empty export specifier is not allowed"). `export const PLUGIN_RUNTIME = "scripts" as const;` keeps the stub a real module without changing runtime behavior.

## Test plan

- [x] Pre-commit hooks green (tsgo + oxlint + madge + import cycles)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Anvil Handoff

- Hammer summary: Commits the 6-line `extensions/bench-reflective-dreaming/index.ts` bundler stub (untracked since 2026-04-20). Should have shipped with #1 or #4. Initially `export {};` but oxlint rejected; ships as `export const PLUGIN_RUNTIME = "scripts" as const;`. Independent of the Phase D2.1 stack.
- Primary paths changed: `extensions/bench-reflective-dreaming/index.ts` (new)
- Verification run: Pre-commit green (tsgo + oxlint + madge + import-cycle).
- Known risks: `PLUGIN_RUNTIME` constant is unreferenced — future tightening of unused-export rules could trip again. Bundler still needs `index.ts` to exist for tsdown discovery.
- Suggested Anvil focus: Run the openclaw bundle (`pnpm build` or equivalent) and confirm tsdown actually emits the dreaming plugin. Compare against other `runtime: "scripts"` plugins for the canonical stub pattern.
