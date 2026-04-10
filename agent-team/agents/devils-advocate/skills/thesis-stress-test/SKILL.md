---
name: thesis_stress_test
description: Stress-test a specialist's thesis by decomposing assumptions and attacking each with evidence, then post a structured review to #contrarian with a verdict and measurable kill conditions. Trigger when an Analyst, Quant, or Scout thesis reaches decision-grade or when a #watchlist name hits a trigger.
---

# Thesis Stress Test

Structured contrarian review of a specialist thesis. Mandatory before Orchestrator publishes anything decision-grade.

## Trigger

- Analyst tags you in `#research` on a decision-grade thesis.
- Quant tags you in `#quant-signals` on a decision-grade backtest.
- Scout flags an unusual move on a `#watchlist` name.
- Orchestrator dispatches a review request in `#dispatch`.

## Inputs

- The thesis or signal you are reviewing (read from the specialist's channel).
- The supporting artifact file (pull via A2A from `files/YYYY-MM-DD/` using `a2a_artifact_pull` if it is referenced by a pointer post).
- Current `#watchlist` tail and recent `#portfolio-daily` decisions for portfolio context.

## Steps

1. **Read the thesis in full** before forming an opinion. If you attack without understanding, the review is worthless.
2. **Decompose into load-bearing assumptions.** List 3–6 assumptions. For each, state what would have to be true.
3. **Attack each assumption with evidence.** Cite from `approved_sources`. Do not use instinct. If you cannot find disconfirming evidence for an assumption, say so — that's a signal the thesis is strong on that leg.
4. **Historical analog.** Find at least one prior episode with similar setup + known outcome. If you cannot, say so explicitly.
5. **Worst-case scenario.** Concrete, quantified, with a probability band.
6. **Portfolio overlap + concentration check.** Does this thesis add correlated exposure to existing `positions.md` (load on demand) or recent decisions in `#portfolio-daily`? If yes, flag it.
7. **Kill condition(s).** Follow `kill_condition_review` — at least one measurable, dated trigger that would invalidate the thesis.
8. **Verdict.** One of: `survives`, `survives with caveats`, `material vulnerabilities`, `reject`.
9. If you are not satisfied with the specialist's inputs, ask follow-up questions in their own channel via `follow_up_questions` before posting the verdict.
10. Save the full review as `files/YYYY-MM-DD/stress-<ticker-or-slug>.md` via `file_layout_discipline`.
11. Post a pointer to `#contrarian` using the format below, tagging `@Orchestrator - Portfolio Manager`.

## Review structure (the file)

1. Thesis summary (one paragraph — prove you understood it)
2. Load-bearing assumptions
3. Per-assumption stress (evidence for + evidence against)
4. Historical analog
5. Worst-case scenario (quantified)
6. Portfolio overlap / concentration
7. Kill conditions (measurable, dated)
8. Verdict
9. Specific requests back to the specialist (if any)

## Pointer format (the Slack post)

```
@Orchestrator - Portfolio Manager  [stress] <TICKER or slug>  verdict: <survives|caveats|vulnerable|reject>
Top 2 risks: ...
Kill conditions: ...
File: files/YYYY-MM-DD/stress-<slug>.md
Confidence in review: <High|Medium|Low>
```

## Where to post

`#contrarian`. Follow-up questions go in the originating specialist's channel.

## Rules

- Demonstrate you understood the thesis before attacking it.
- Tie every objection to evidence from `approved_sources`.
- Say clearly when a thesis survives scrutiny. No performative skepticism.
- Preserve disagreement. Never soften a verdict to make the team comfortable.
- Never skip the kill condition.

## Next step

Append to `files/index.md`. If the verdict is `material vulnerabilities` or `reject`, expect Orchestrator to either pause the decision or dispatch the specialist to address the gaps — stand by in `#contrarian` for round two.
