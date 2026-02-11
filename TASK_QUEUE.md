# TASK_QUEUE.md -- Agent Task Queue
**Version:** v1.0
**Date:** 2026-02-06
**Owner:** Andrew (Founder)
**Status:** Active. This is the only place agents pull work from.

---

## 0) Rules

- This file is the ONLY execution queue for agents. No other file authorizes work.
- `docs/_sophie_devpack/TODO_QUEUE.md` is the Sophie roadmap. It is NOT an execution queue. Agents MUST NOT pull tasks from it.
- Agents MUST only work on tasks listed in this file with status `READY`
- Agents MUST set status to `IN_PROGRESS` before starting work
- Agents MUST set status to `COMPLETED` or `FAILED` when done
- Only one task may be `IN_PROGRESS` at a time
- Tasks not in this file are not authorized

### Status Values

| Status | Meaning |
|--------|---------|
| READY | Prerequisites met. Safe to execute. |
| BLOCKED | Prerequisites missing. Do not attempt. |
| IN_PROGRESS | Currently being worked. Lock held. |
| COMPLETED | Done. Verified. |
| FAILED | Attempted and failed. Needs human review. |

### Task Entry Format

```
### <TASK-ID>: <Short Description>
- **Status:** READY | BLOCKED | IN_PROGRESS | COMPLETED | FAILED
- **Type:** docs | test | fix | feature
- **Prerequisites:** List of required tasks or conditions
- **Definition of Done:** What must be true for this to be complete
- **Max Diff:** Estimated lines changed
- **Notes:** Additional context
- **Assigned:** <agent name or "unassigned">
- **Branch:** <branch name if in progress>
- **Completed:** <date if completed>
```

---

## 1) Active Tasks

### GOV-003: Update Cursor rules stale Moonshot model ID
- **Status:** COMPLETED
- **Type:** docs
- **Prerequisites:** None
- **Definition of Done:** All occurrences of `kimi-k2.5` in `.cursor/rules/*.md` that refer to the Moonshot default model ID are replaced with `kimi-k2-0905-preview`. `rg -n "kimi-k2\.5" .cursor/rules` returns 0 matches. `rg -n "kimi-k2-0905-preview" .cursor/rules` shows expected replacements. No runtime code changes. No other wording changes.
- **Max Diff:** ~10 lines
- **Notes:** Mode: SAFE_DOCS_ONLY. These are Cursor IDE agent instruction files, not runtime code. The stale model ID was identified during governance audit. Source of truth is `src/agents/models-config.providers.ts:35` which reads `kimi-k2-0905-preview`. Provide grep receipts before and after.
- **Assigned:** claude-code
- **Branch:** main
- **Completed:** 2026-02-07

### INGEST-001: Commit ingest_local_file tool + tests
- **Status:** IN_PROGRESS
- **Type:** feature
- **Prerequisites:** None
- **Definition of Done:** The 4 files (`src/agents/tools/ingest-tool.ts`, `src/agents/tools/ingest-tool.test.ts`, `src/agents/moltbot-tools.ts`, `RUNBOOK.md`) are committed to main. `pnpm lint`, `pnpm build`, and targeted `pnpm test` for the ingest tool pass. Commit message: `feat(ingest): add ingest_local_file tool (v0)`.
- **Max Diff:** ~200 lines (2 new files, 2 minimal edits)
- **Notes:** Implementation already complete. Commit only — no refactors, no new features.
- **Assigned:** claude-code
- **Branch:** main
- **Completed:** --

### FIX-001: Fix overflow-compaction test vi.mock missing resolveDefaultProvider export
- **Status:** READY
- **Type:** fix
- **Prerequisites:** None
- **Definition of Done:** All 4 tests in `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` pass. The vi.mock of `../defaults.js` re-exports `resolveDefaultProvider` and `resolveDefaultModel` using `importOriginal`. `pnpm test` shows 0 failures in this file.
- **Max Diff:** ~10 lines
- **Notes:** Pre-existing failure. The test mocks `../defaults.js` but does not re-export `resolveDefaultProvider`, which `run.ts:99` imports. Error: `[vitest] No "resolveDefaultProvider" export is defined on the "../defaults.js" mock`. Deterministic failure, 100% reproducible on main branch at commit 9a30a7947. Not caused by any recent PR.
- **Assigned:** unassigned
- **Branch:** --
- **Completed:** --

---

## 2) Example Tasks (FOR REFERENCE ONLY -- DO NOT EXECUTE)

> The tasks below are examples showing correct format. They are marked EXAMPLE
> and must not be executed. Remove this section when real tasks are added.

### EXAMPLE-001: Add unit test for session key format
- **Status:** EXAMPLE (not a real task)
- **Type:** test
- **Prerequisites:** None
- **Definition of Done:** Test file exists at `src/gateway/session-key.test.ts`; asserts canonical key format `agent:{agentId}:{channel}:{accountId}:dm:{peerId}`; `pnpm test` passes.
- **Max Diff:** ~50 lines
- **Notes:** See `docs/_sophie_devpack/02_CONTRACTS/interfaces_contracts_spec_sophie_moltbot.md` section 5.1 for key format spec.
- **Assigned:** unassigned
- **Branch:** --
- **Completed:** --

### EXAMPLE-002: Document moonshot smoke test procedure
- **Status:** EXAMPLE (not a real task)
- **Type:** docs
- **Prerequisites:** None
- **Definition of Done:** `RUNBOOK.md` updated with moonshot smoke test steps; includes expected output; references `pnpm moltbot moonshot:smoke`.
- **Max Diff:** ~30 lines
- **Notes:** Smoke test already exists. This is documentation only.
- **Assigned:** unassigned
- **Branch:** --
- **Completed:** --

### EXAMPLE-003: Fix typo in startup log message
- **Status:** EXAMPLE (not a real task)
- **Type:** fix
- **Prerequisites:** None
- **Definition of Done:** Typo corrected in `src/gateway/server-startup-log.ts`; no logic changes; `pnpm test` passes.
- **Max Diff:** 1 line
- **Notes:** Minimal diff. No behavior change.
- **Assigned:** unassigned
- **Branch:** --
- **Completed:** --

---

## 3) Completed Tasks

<!-- Move completed tasks here with their completion date. -->

---

## 4) Failed / Blocked Tasks

<!-- Move failed or blocked tasks here with explanation. -->

---

## 5) Cross-References

- For Sophie implementation roadmap: `docs/_sophie_devpack/TODO_QUEUE.md`
- For agent behavior rules: `AGENT_WORK_CONTRACT.md`
- For verification procedures: `RUNBOOK.md`
- For authority rules: `CLAUDE.md`

---

**End of task queue.**
