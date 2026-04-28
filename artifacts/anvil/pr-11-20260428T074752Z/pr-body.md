## Summary

Adds an optional `instanceId` field to `OpenClawConfig` (top-level). Validates as 1-128 chars matching `[A-Za-z0-9_-]+` so the value is filesystem-safe for use as a path component.

When set, downstream features scope per-instance resources to this id:

- memory-wiki vault path → `~/.openclaw/wiki/{instanceId}/` (PR follow-up)
- cloud-mirror daemon state file → `~/.openclaw/state/wiki-mirror.{instanceId}.json` (PR follow-up)
- health snapshot → surfaces `instanceId` field (PR follow-up)
- shard directory layout — already wired in `BenchAGI_Mono_Repo` PR #477

When unset, single-user Tier A defaults apply (`~/.openclaw/wiki/main/`).

## Why

Phase D2.1 hardening — the per-business shard architecture from `BenchAGI_Mono_Repo` PR #477 (Phase D2 monorepo) requires the harness to know which Bench instance it belongs to so it can scope filesystem resources. This is the fork-side foundation PR; B/C/D follow.

## Changes

- `src/config/types.openclaw.ts`: new optional `instanceId` field on `OpenClawConfig`.
- `src/config/zod-schema.ts`: `instanceId` validator (`z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional()`).
- `src/config/schema.help.ts` / `schema.labels.ts`: human-readable label + help.
- `src/config/schema.base.generated.ts`: regenerated via `pnpm config:schema:gen` — adds the new field block; also picks up the stale `required: ["command"]` removal from PR #5.
- `src/config/config-misc.test.ts`: 3 new tests (accept valid, accept absent, reject path-traversal/empty/slash).

## Dependent PRs

- PR B (forthcoming): `feat(health): surface instanceId on health snapshot`
- PR C (forthcoming): `feat(memory-wiki): scope vault path to instanceId`
- PR D (forthcoming): `feat(claude-code-bridge): cloud-mirror reads instanceId for per-vault scoping`

## Test plan

- [x] `pnpm vitest run src/config/config-misc.test.ts` — 54 tests pass
- [x] `pnpm config:schema:check` — schema regen idempotent
- [x] Pre-commit hooks (tsgo + oxlint + madge + import-cycle) pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Anvil Handoff

- Hammer summary: Foundation PR for Phase D2.1. Adds optional top-level `instanceId` to `OpenClawConfig` with strict regex `/^[A-Za-z0-9_-]{1,128}$/` so the value is filesystem-safe. Three other PRs (#12 health, #13 memory-wiki, #14 cloud-mirror) stack on this. Generated `schema.base.generated.ts` via `pnpm config:schema:gen`; the regen also clears a stale `required: ["command"]` in cliBackends that should have shipped with already-merged #5.
- Primary paths changed: `src/config/types.openclaw.ts`, `src/config/zod-schema.ts`, `src/config/schema.help.ts`, `src/config/schema.labels.ts`, `src/config/schema.base.generated.ts`, `src/config/config-misc.test.ts`
- Verification run: `pnpm vitest run src/config/config-misc.test.ts` → 54 passed (3 new). `pnpm config:schema:check` clean. Pre-commit (tsgo + oxlint + madge + import-cycle) green.
- Known risks: (1) Generator delta also removes `required: ["command"]` from cliBackends — confirm matches PR #5 runtime intent and isn`'t a regression. (2) The `[A-Za-z0-9_-]{1,128}`regex is duplicated in #13 (memory-wiki config) and #14 (cloud-mirror.mjs); a copy edit could let them drift. (3) New top-level field on`OpenClawConfig`— confirm no other validators with`additionalProperties: false` would reject configs that have it.
- Suggested Anvil focus: Idempotency (`pnpm config:schema:gen` again, expect no diff). Byte-for-byte alignment between zod regex and emitted JSON-schema pattern. Search for additional consumers of `cfg.instanceId` we should wire (CLI banners, logs, agent identity).
