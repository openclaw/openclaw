# Validation — Task budgets

## Automated tests

- `src/sessions/task-budget.test.ts` — schema validation, `sessions.patch` round-trip, default off.
- `src/agents/pi-embedded-runner/task-budget-accounting.test.ts` — `spent` increments correctly; `remaining` available pre-call.
- `src/agents/pi-embedded-runner/extra-params-budget.test.ts` — Anthropic task-budget params emitted only on capable models.
- `src/agents/compaction-budget.test.ts` — tight compaction chosen when `remaining < threshold`.
- `src/auto-reply/commands-registry-budget.test.ts` — `/budget` chat command updates the session.
- E2E: `scripts/e2e/task-budget-docker.sh` — fixture session with a small budget runs to budget exhaustion and emits the typed end event.

## Smoke checks

- `openclaw sessions set <key> --budget-tokens 5000 --budget-wallclock 60000` then run a long task; `/status` shows `budget=5000 remaining=...`; loop ends on exhaustion with a final reply.
- `/budget reset` clears the budget mid-session.
- Wall-clock budget alone (no token budget) triggers a clean stop after the configured ms.

## Manual criteria

- `/status` budget row is readable and aligned with the existing table rendering (`src/terminal/table.ts`).
- End-of-budget final reply explains *why* the loop ended ("budget exhausted: spent 5000/5000 tokens"), not a cryptic error.

## AI eval plan

- Success criteria: with a 5000-token budget on a multi-tool task, the model finishes within budget ≥ 85% of the time and surfaces a "stopping early" reply when it can't, on a 12-task fixture set.
- Eval dataset: `tests/evals/task-budget/` — task prompts × budget sizes.
- Regression set: 3 budgets (tight 2k / nominal 20k / generous 200k) × 4 tasks (single tool, multi tool, no tool, compaction needed).
- Cadence: per-PR on fixtures; nightly on the live-models matrix to validate Anthropic's countdown is being read.

## Risks & rollback

- **Risks:**
  - Model misreads the countdown and stops early on simple tasks. *Detect via* the eval set; mitigate by keeping default off.
  - Compaction tightens too aggressively and drops needed context. *Detect via* the existing "summarize dropped messages" safeguard from 2026.1.x.
  - Soft wall-clock fires during a tool call and leaves a tool result orphaned. *Mitigate* by deferring stop to the next agent loop iteration.
- **Rollback:** unset `taskBudget` per session, or revert the PR. Both safe.

## Open questions

- Should `/budget` show a percentage in `/status` (e.g., "30% remaining") or only absolute? Probably both.
