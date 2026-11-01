feat(audit): record observed runtime skill usage

## What Problem This Solves

OpenClaw can emit skill-usage diagnostics while an agent reads or invokes a skill, but that observed runtime signal is not available through the durable audit surface. Operators therefore cannot inspect which skills were actually used during a run from the audit CLI/API.

## Why This Change Was Made

The first revision inferred skill selection from prompt text after attempt completion. Review correctly called that out as the wrong boundary: prompt inference is not proof of skill use and it also risked perturbing the embedded attempt-result contract.

This revision records only observed runtime skill usage from the existing `before_tool_call` skill-usage boundary:

- Skill read/command activation is detected where `recordRunSkillUsage()` already emits runtime diagnostics.
- A metadata-only `skill_selection` audit event is emitted with `selectionSource: "observed_runtime"` and `selectionConfidence: "observed"`.
- No prompt text, tool arguments, tool output, or skill file contents are persisted.
- `skill_selection` is persisted outside run-start deduplication so it is not dropped after `agent.run.started`.
- Legacy `audit.list` remains run/tool-only; the versioned `audit.activity.list` surface exposes skill-selection records.
- `completeEmbeddedAttemptResult()` is restored to the production calling contract, preserving the existing truncated-stream/tool recovery behavior.

## User Impact

- `openclaw audit --kind skill_selection` can show observed skill usage for a run through the activity-list API.
- Existing `audit.list` clients keep their shipped run/tool event shape and do not receive the new record kind.
- Operators get a durable metadata trail for actual skill usage without sensitive prompt or file-content capture.

## Evidence

Current-head validation after merging `upstream/main` and removing the unrelated `USER.md` bootstrap policy change:

```bash
pnpm tsgo:core
pnpm protocol:check:swift
pnpm db:kysely:check
pnpm lint:kysely
pnpm check:architecture
pnpm test src/agents/workspace.bootstrap-privacy.test.ts src/audit/audit-events.test.ts src/gateway/server-methods/audit.test.ts packages/gateway-protocol/src/schema/audit.test.ts
```

Results:

- `pnpm tsgo:core` passed.
- `pnpm protocol:check:swift` passed after regenerating `GatewayModels.swift`.
- `pnpm db:kysely:check` passed after regenerating `src/state/openclaw-state-db.generated.d.ts`.
- `pnpm lint:kysely` passed after moving ordinary companion-table insert/read/prune queries to the sync Kysely owner.
- `pnpm check:architecture` passed, including generated Kysely verification, Kysely guardrails, and database-first legacy-store guard.
- Targeted Vitest run passed 4 shards in 22.13s.
- `audit-events.test.ts`: 54 tests passed, including companion-table storage, bounded retention, and observed runtime projection.
- `server-methods/audit.test.ts`: 34 tests passed, including explicit `skill_selection`/`observed` activity access and V1-compatible unfiltered activity.
- `audit.test.ts`: 7 protocol schema tests passed, including activity schema discrimination.
- `workspace.bootstrap-privacy.test.ts`: 9 tests passed; shared sessions now drop only root `MEMORY.md`, leaving `USER.md` behavior unchanged.
- `pnpm exec oxlint src/audit/audit-event-store.skill-selection-storage.ts src/state/openclaw-state-db.generated.d.ts` passed. A full local `pnpm lint:core` was started but manually stopped after 6+ minutes with no diagnostic output; CI remains the authoritative full core-lint signal.

Upgrade/reopen proof against an existing database created from `upstream/main` schema:

- before candidate open: `audit_events` had 1 legacy row and `audit_skill_selection_events` did not exist.
- after candidate open: SQLite `user_version` was 17, the legacy `audit_events` row remained, and `audit_skill_selection_events` existed.
- after recording observed skill usage: `audit_skill_selection_events` had 1 row for `demo-skill`; legacy `audit_events` still had 1 row.
- `listAuditEvents({ kind: "skill_selection" })` returned `["skill_selection"]`.
- unfiltered `listAuditEvents(...)` returned only `["agent_run"]`, preserving the old reader/default activity behavior.
- after closing and reopening the candidate database, `audit_skill_selection_events` still had 1 row.

Older-reader open/use compatibility proof:

- candidate head wrote a `skill_selection` record into a fresh state DB: `skillSequences: [1]`.
- `upstream/main` at `ca28965b39b` then opened the same DB and wrote an `agent_run` record: `visibleSequences: [2]`, `kinds: ["agent_run"]`.
- candidate head reopened the DB and wrote a second `skill_selection` record.
- candidate readback returned `skillSequences: [3, 1]`; default activity returned only `defaultKinds: ["agent_run"]`, `defaultSequences: [2]`.
- physical SQLite readback confirmed shared ordering: `audit_events` contained sequence `2`, `audit_skill_selection_events` contained sequences `1` and `3`, and `sqlite_sequence` for `audit_events` was `3`.

## Changed Files

- `src/skills/runtime-skill-selection.ts` — observed-only metadata marker.
- `src/agents/agent-tools.before-tool-call.wrapper.ts` — emits `skill_selection` from the existing observed skill-usage boundary.
- `src/audit/agent-event-audit.ts` — projects observed-only skill-selection records and routes them outside run-start deduplication.
- `src/audit/audit-event-store.ts` / `src/audit/audit-event-store.skill-selection-storage.ts` / `src/audit/audit-event-types.ts` — durable store/types for observed skill-selection metadata, with ordinary companion-table access through Kysely.
- `src/state/openclaw-state-db.generated.d.ts` — generated Kysely declarations for the companion table.
- `src/gateway/server-methods/audit.ts` — exposes skill-selection through `audit.activity.list` while preserving legacy `audit.list`.
- `packages/gateway-protocol/src/schema/audit-activity.ts` — versioned activity schema includes `skill_selection`.
- `packages/gateway-protocol/src/schema/audit.ts` — legacy audit schema stays run/tool-only.
- `src/commands/audit.ts` — CLI uses the activity surface and renders selected skill metadata.

## Test Plan

1. Verify observed skill reads/commands emit `skill_selection` audit events.
2. Verify `skill_selection` persists between run start and terminal events.
3. Verify `audit.activity.list` and CLI expose skill-selection records.
4. Verify legacy `audit.list` remains run/tool-only.
5. Verify attempt-result recovery tests still pass.
6. Verify existing SQLite state opens, creates the companion table, preserves old activity rows, and reopens with skill-selection rows intact.
