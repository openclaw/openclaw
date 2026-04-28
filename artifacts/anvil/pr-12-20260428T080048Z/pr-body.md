## Summary

Adds an optional `instanceId` field to `HealthSummary`. When `OpenClawConfig.instanceId` is set, the snapshot includes it; when unset (Tier A single-user default), the field is omitted via conditional spread.

## Why

Phase D2.1 — relay-side health/heartbeat probes need to identify which Bench instance a harness belongs to without reaching back into the config file. Surfacing on `HealthSummary` is the cheapest path.

## Changes

- `src/commands/health.ts`: conditional spread of `instanceId` into the snapshot when `cfg.instanceId` is set.
- `src/commands/health.types.ts`: typed `instanceId?: string` on `HealthSummary` with doc comment.
- `src/commands/health.snapshot.test.ts`: 2 new tests (Tier A omits, Phase D2.1 surfaces).

## Stacked PR

This PR is stacked on top of #11 (`feat(config): top-level instanceId field`). Once #11 merges, GitHub will auto-rebase this PR onto `main`.

## Test plan

- [x] `pnpm vitest run src/commands/health.snapshot.test.ts` — 6 tests pass
- [x] Pre-commit hooks green

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Anvil Handoff

- Hammer summary: Optional `instanceId?: string` on `HealthSummary`. Conditional spread `...(cfg.instanceId ? { instanceId } : {})` so Tier A heartbeats omit the field rather than emit `instanceId: undefined`. Stacked on #11.
- Primary paths changed: `src/commands/health.ts`, `src/commands/health.types.ts`, `src/commands/health.snapshot.test.ts`
- Verification run: `pnpm vitest run src/commands/health.snapshot.test.ts` → 6 passed (2 new: Tier A omits, Phase D2.1 surfaces). Pre-commit green.
- Known risks: `HealthSummary` is consumed externally (relay-side health probe + monorepo dashboards). Adding an optional field is backward-compatible by spec, but downstream zod validators with `.strict()` would reject. Need to confirm relay-side parser tolerates the new shape.
- Suggested Anvil focus: Grep across all repos that consume `HealthSummary` (relay, web app, dashboards) and verify the schema is permissive of the new optional field. Confirm test coverage distinguishes "field absent" from "field present and undefined" — the omit-via-spread pattern is intentional.
