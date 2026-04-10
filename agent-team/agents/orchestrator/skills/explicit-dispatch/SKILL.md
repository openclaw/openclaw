---
name: explicit_dispatch
description: Send exactly one precise question to exactly one specialist in #dispatch with a required reply channel and deadline, splitting any multi-question or multi-agent input into separate posts. Trigger whenever the Orchestrator needs work from a specialist.
---

# Explicit Dispatch

Enforced lane-discipline dispatch. This skill refuses multi-question or multi-agent inputs — it forces you to split them into separate posts. This is the only way you assign work.

## Trigger

You (Orchestrator) need work from a specialist: a research thesis from Analyst, a computation from Quant, a scan or lookup from Scout, a stress-test from Devil's Advocate.

## Inputs

- The task as you are currently framing it in your head.
- The target specialist.
- The deadline in America/New_York.

## Pre-flight check (reject if any fail)

1. **One question.** If your input contains "and also," "plus," "while you're at it," or two question marks, STOP. Split into N separate dispatches, one per question, and run this skill N times.
2. **One specialist.** If you want to ask Scout AND Quant, STOP. Two specialists means two dispatches.
3. **Exact handle.** You must use the specialist's exact `@App Name` mention from `channel_directory` / `channel-map.md`. Without the mention, they do not see the post.
4. **Required reply channel.** Pick the single specialist-owned channel where the reply must land. Never ask for a reply in `#portfolio-daily` — that's your publishing channel.
5. **Deadline.** ET, explicit. Never "ASAP," never "when you can."

If any of these fail, abort the dispatch, split the work, and restart.

## Steps

1. Run the pre-flight check above. Split into multiple dispatches if needed.
2. For each dispatch, compose one Slack post in `#dispatch` using the output format below.
3. Save a one-line dispatch record to `files/YYYY-MM-DD/dispatch-<HHMM>-<specialist>.md` via `file_layout_discipline` — just the question, target, deadline, required reply channel. This is your audit trail.
4. Watch for the ✅ reaction (receipt ack) from the specialist within a reasonable window. If missing, re-post with `@` mention and escalate per `shared/portfolio/error-handling.md`.

## Output format

```
@<Specialist Exact App Name>  [dispatch] <one precise question>
Reply in: #<channel>
Tag in your reply: @Orchestrator - Portfolio Manager
Deadline: <HH:MM ET, today | YYYY-MM-DD>
Context: <one line; link files via path if an artifact is relevant>
```

## Where to post

`#dispatch` only. Never in the specialist's own channel.

## Rules

- ONE question per dispatch.
- ONE specialist per dispatch.
- Never ask two specialists the same question — that duplicates work and causes path-dependency (see Anthropic multi-agent research).
- Never dispatch without a deadline.
- Never dispatch via A2A. A2A is for pulling finished artifacts only.
- If a specialist replies with a clarifying question, answer it in `#dispatch` — don't get dragged into a side thread.

## Next step

Append the dispatch record to `files/index.md`. Wait for the specialist's reply in the required channel. When it lands, feed it into `portfolio_decision_brief` if synthesis is the next step.
