## Summary

Threads `instanceId` from `OpenClawConfig` into the memory-wiki config resolver so each Bench instance gets its own vault directory:

- Tier A (no instanceId) → `~/.openclaw/wiki/main/`
- Tier B/C (instanceId set) → `~/.openclaw/wiki/{instanceId}/`

Explicit `vault.path` overrides still win, so existing single-user deployments that set a custom vault path are unaffected.

## Why

Phase D2.1 — per-instance harnesses (Tier B local, Tier C cloud) need filesystem isolation between vaults so multi-tenant signals never co-mingle. The vault dir is the most security-relevant place to scope; the cloud-mirror state file (PR D) follows.

## Changes

- `extensions/memory-wiki/src/config.ts`:
  - `INSTANCE_ID_PATTERN` + `normalizeInstanceId()` — local copy of the same regex used by `src/config/zod-schema.ts` (kept local because memory-wiki doesn't import from `src/config/*`).
  - `resolveDefaultMemoryWikiVaultPath(homedir, instanceId?)` — appends `{instanceId}` or `main`.
  - `resolveMemoryWikiConfig(config, { homedir, instanceId })` — accepts the new option.
- `extensions/memory-wiki/index.ts` + `cli-metadata.ts` + `src/cli.ts`: thread `appConfig.instanceId` through to the resolver.
- `extensions/memory-wiki/src/config.test.ts`: 7 new tests (vault scoping happy paths + path-traversal/empty/slash fallback to `main/`).

## Path-traversal hardening

Inputs like `"../evil"`, `"has/slash"`, `""`, or anything not matching `[A-Za-z0-9_-]{1,128}` fall back to `main/` rather than scoping into a malicious dir. Verified by tests.

## Stacked PR

Stacked on #11. Once #11 merges, GitHub auto-rebases this onto `main`. Orthogonal to #10 (canon-kind indexing).

## Test plan

- [x] `pnpm vitest run extensions/memory-wiki/src/config.test.ts` — 11 tests pass
- [x] Pre-commit hooks green

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Anvil Handoff

- Hammer summary: Threads `appConfig.instanceId` into `resolveMemoryWikiConfig` and `resolveDefaultMemoryWikiVaultPath`. Vault becomes `~/.openclaw/wiki/{instanceId}/`; falls back to `main/` when unset or invalid. Path-traversal inputs (`../evil`, `has/slash`, `""`, anything not matching the regex) safely fall back to `main/`. Stacked on #11. Orthogonal to open #10 (canon-kind indexing) — verified zero file overlap.
- Primary paths changed: `extensions/memory-wiki/cli-metadata.ts`, `extensions/memory-wiki/index.ts`, `extensions/memory-wiki/src/cli.ts`, `extensions/memory-wiki/src/config.ts`, `extensions/memory-wiki/src/config.test.ts`
- Verification run: `pnpm vitest run extensions/memory-wiki/src/config.test.ts` → 11 passed (7 new covering vault scoping happy paths + path-traversal fallback). Pre-commit green.
- Known risks: (1) **No migration helper** — installs that already have content under `~/.openclaw/wiki/main/` will keep using it (since `instanceId` defaults unset); flipping `instanceId` later creates a fresh `wiki/{instanceId}/` and orphans the previous content. (2) `INSTANCE_ID_PATTERN` regex is a local copy of the one in #11`'s `zod-schema.ts`— drift risk. (3) Explicit`vault.path`config override beats the new`instanceId` scoping; the documented precedence isn`'t surfaced in `schema.help.ts`.
- Suggested Anvil focus: Find every caller of `resolveMemoryWikiConfig` to confirm `appConfig.instanceId` is threaded everywhere (the PR touches `cli-metadata.ts`, `index.ts`, `src/cli.ts` — anywhere else?). Verify the path-traversal test set covers all variants the regex would reject (Unicode, leading `.`, `null`, `Symbol()`). Check whether the `vault.path` override + `instanceId` interaction needs documentation in `schema.help.ts`.
