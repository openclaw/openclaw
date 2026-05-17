# Requirements — Task budgets

## Outcome

Long-running agent sessions can be given a token budget for an entire agentic loop; the model receives a running countdown and uses it to prioritize work, surface progress, and stop gracefully when the budget is exhausted. Operators see budget + spent in `/usage` and `/status`, and compaction triggers honor the remaining budget (so we don't compact away context the model still needs for the budget it was given).

## Users affected

- Operators starting a long agentic task (e.g., "fix the failing test suite", "summarize this 500-page PDF").
- Pi-embedded agent runtime — `src/agents/pi-embedded-runner/`.
- Session model — `src/sessions/`, particularly `sessions.patch` (per-session settings) and the compaction safeguard.
- Chat commands — `/status`, `/usage`, `/compact` need to expose budget state.

## In scope

- Per-session `taskBudget` setting (`tokens`, `wallClockMs`, `compactionPolicy`) configurable via `sessions.patch` and a new `/budget <n>` chat command.
- Inject Anthropic's task-budget primitive into the request extra-params when on Opus 4.7+ via `src/agents/pi-embedded-runner/extra-params.ts`.
- Budget countdown visible in `/status` and in the existing `/usage` footer when enabled.
- Compaction safeguard reads `remainingBudget` and prefers a smaller summary when the budget is tight.
- Auto-stop on budget exhaustion with a typed end-of-loop result the operator sees as a final reply.

## Out of scope

- Cost-based budgets in dollars — keep it tokens + wall-clock for v1 (cost can be derived).
- Cross-session budget pooling.
- Budget enforcement for non-Anthropic providers (the primitive is Anthropic-specific in May 2026; for other providers we maintain a soft local guard but the model doesn't see the countdown).
- Auto-extend on budget hit — operator-initiated only.

## Decisions

- Token budget is the primary unit. Reason: it's what the Anthropic primitive expects and what compaction reasons about.
- `wallClockMs` is an additional soft cap that ends the loop without involving the model. Reason: protects against runaway tool-call loops that don't burn many tokens.
- Default budget = unset (current behavior unchanged). Reason: avoid surprising current operators.
- Surface `remainingBudget` in `/status` even when budget is unset — show "no budget" rather than hide the row.
