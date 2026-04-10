---
name: kill_condition_review
description: Produce at least one measurable, dated, action-bound kill condition for a thesis. Trigger whenever Devil's Advocate reviews a decision-grade thesis or the Orchestrator asks for an explicit invalidation criterion.
---

# Kill Condition Review

Every decision-grade thesis needs at least one kill condition. This skill produces them. It runs inside `thesis_stress_test` as step 7, and can also run standalone on request.

## Trigger

- Inside `thesis_stress_test` before the verdict.
- Orchestrator dispatches `"give me a kill condition for thesis X"`.
- A prior kill condition trips and the team needs to replace it.

## Inputs

- The thesis statement.
- The load-bearing assumption(s) identified in `thesis_stress_test`.
- Current portfolio context (positions, recent decisions from `#portfolio-daily`).

## Steps

For each load-bearing assumption, produce one kill condition with all four of:

1. **Observable metric** — something the team can actually measure (price, volume, earnings line item, macro print, filing event). No feelings, no vague "sentiment."
2. **Threshold** — a specific number or event.
3. **Timeframe** — a date or duration.
4. **Action** — what the team does when it trips. One of: `exit position`, `cut size by half`, `pause new adds`, `re-dispatch for updated research`, `escalate to Orchestrator`.

## Output format

```
Kill condition: <assumption it invalidates>
- Metric: <observable>
- Threshold: <number or event>
- By: <date | duration>
- Action: <action>
```

List multiple kill conditions if the thesis has multiple load-bearing legs.

## Rules

- No vague worries ("if things get worse"). Only measurable conditions.
- Every kill condition must tie to one specific assumption. If you cannot name the assumption, the kill condition is unmoored.
- Prefer leading indicators to lagging ones when both exist.
- If you cannot produce at least one measurable kill condition, the thesis is not decision-grade. Say so in the verdict.

## Where to post

Inline in the `thesis_stress_test` output file and pointer post. If standalone, post directly to `#contrarian` and tag `@Orchestrator - Portfolio Manager`.

## Next step

If a kill condition is time-bound within the next 5 trading days, flag it in the pointer and add it to your own `MEMORY.md` under "Open threads (kill-condition watch list)" so you check it next session.
