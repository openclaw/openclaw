# Plan — Task budgets

## Approach

Store `taskBudget` on the session record alongside the existing `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, `groupActivation` keys patched via `sessions.patch`. Plumb it into Pi-embedded extra-params so the Anthropic task-budget primitive is emitted on every model turn (the model sees the countdown and adapts). Compaction safeguard reads the remaining budget and tightens. Chat commands `/budget` + updated `/status` + `/usage` give the operator live visibility.

## Steps

1. Extend `src/sessions/` session schema with optional `taskBudget: { tokens?: number, wallClockMs?: number, compactionPolicy?: "tight"|"normal" }`.
2. Extend `sessions.patch` WS method (and the corresponding Swift/Web UI bindings) to accept `taskBudget` updates; regenerate via `pnpm protocol:check`.
3. Track `spent` and `startedAt` per turn in `src/agents/pi-embedded-runner/` so `remaining = tokens - spent` is available before each model call.
4. Inject Anthropic task-budget params into `pi-embedded-runner/extra-params.ts` when the model supports it and budget is set.
5. Wire a soft wall-clock guard: `setTimeout` that calls `agent.stop()` with a typed end-of-loop event.
6. Compaction safeguard (`src/agents/`) reads `remaining` and chooses a shorter compaction summary when remaining < threshold.
7. Chat commands: add `/budget <tokens>` and `/budget reset` to the auto-reply registry (`src/auto-reply/commands-registry.ts`); extend `/status` + `/usage` output to include `budget=` + `remaining=` rows.
8. CLI: `openclaw sessions set <sessionKey> --budget-tokens 50000 --budget-wallclock 600000`.
9. Docs: extend `docs/concepts/session.md` + add a "task budgets" subsection.

## Dependencies / order

- Steps 1–2 (schema + RPC) block everything else.
- Step 3 (accounting) blocks 4 and 6.
- Step 5 (wall clock) is independent.
- Steps 7–9 land after the core path works.
