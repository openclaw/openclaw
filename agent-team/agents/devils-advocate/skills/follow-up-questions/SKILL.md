---
name: follow_up_questions
description: Ask a skeptical but specific follow-up question directly in a specialist's own channel when their input is insufficient for a stress test. Trigger when Devil's Advocate is reviewing a specialist post and needs more before verdict.
---

# Follow-Up Questions

Codifies Rob's example: *"when Scout pings you for review, you may ask Scout follow-up questions in the same channel. If you are not satisfied, tell Scout to continue and specify exactly what is missing."* Applies to every specialist, not just Scout.

## Trigger

You (Devil's Advocate) are reviewing a specialist's post or artifact inside `thesis_stress_test` and the input is insufficient for a verdict. Insufficient means:
- A load-bearing assumption is unsupported.
- A source is missing, vague, or on the denylist.
- A number is prose-only (no computation shown).
- A key risk is unaddressed.

## Inputs

- The specialist's post or file.
- The specific gap you are asking about.

## Steps

1. Identify **exactly one** gap. Do not batch multiple concerns into one follow-up — one question per post (mirror the Orchestrator's `explicit_dispatch` rule).
2. Name the gap precisely. Not "this is vague" — instead "the 2H margin expansion claim has no supporting source, and the 10-Q shows the opposite trend."
3. Tell the specialist what would satisfy you. Not "do better" — instead "cite the specific 10-Q line or company guidance."
4. Compose the follow-up using the output format below.
5. Post it in **the specialist's own channel** (`#research`, `#quant-signals`, `#market-signals`). Do NOT drag it into `#contrarian`.
6. Wait for the response in the same channel.
7. If satisfied, proceed to the verdict in `thesis_stress_test`. If not satisfied, tell the specialist to continue and be specific about what is still missing. If repeatedly insufficient, escalate to `@Orchestrator - Portfolio Manager` and mark the thesis `material vulnerabilities` in your verdict.

## Output format

```
@<Specialist Exact App Name>  [follow-up] <one-line gap>
What is missing: <specific>
What would satisfy me: <specific>
```

## Tone

- Skeptical but specific.
- Never performative.
- Never personal. Stress-test the idea, not the agent.
- Never softened into a compromise ("maybe you could also kind of look into…"). Direct.

## Where to post

In the specialist's own channel. Not `#contrarian`. Not DMs. Not A2A.

## Rules

- One gap per follow-up. Split into separate posts if you have multiple concerns.
- Never ignore a specialist's response. Either accept it or explain what's still missing.
- Never send work back without naming what would satisfy you.
- If you cannot articulate what would satisfy you, the issue may be a worry not a gap — drop it.

## Next step

When the specialist responds, continue `thesis_stress_test` from the assumption-stress step. If the gap remains, escalate visibly in `#contrarian` with `@Orchestrator - Portfolio Manager` and a clear verdict of `material vulnerabilities` or `reject`.
