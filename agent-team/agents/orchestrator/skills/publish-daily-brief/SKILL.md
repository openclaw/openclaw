---
name: publish_daily_brief
description: Publish the canonical daily decision brief to #portfolio-daily as the record of decision. Trigger after portfolio_decision_brief has composed the brief file.
---

# Publish Daily Brief

Posts the brief composed by `portfolio_decision_brief` to `#portfolio-daily`. That channel post IS the canonical record of decision — there is no `recent-decisions.md`.

## Trigger

You (Orchestrator) have just composed a decision brief via `portfolio_decision_brief` and the file exists at `files/YYYY-MM-DD/brief-<slug>.md`.

## Inputs

- The brief file path.
- The decision or options to publish.
- Any relevant specialist pointers (research file, backtest JSON, stress-test file).

## Steps

1. Verify the brief file exists and is complete (thesis, cases, options, confidence, kill conditions).
2. Read the last ~10 messages in `#portfolio-daily` to confirm continuity (don't reopen a closed decision without new evidence).
3. Compose the Slack post using the output format below.
4. Post to `#portfolio-daily`. This post IS the canonical decision record.
5. If the brief requires human action, tag the operator in-post.

## Output format

```
[daily] <YYYY-MM-DD>  <TICKER or theme>
Thesis: <one sentence>
Decision: <one sentence — options, not orders>
Confidence: <High|Medium|Low>
Bull: <one line, cite specialist + channel>
Bear: <one line, cite specialist + channel>
Disagreement preserved: <if any>
Kill conditions: <measurable, from Devil's Advocate>
File: files/YYYY-MM-DD/brief-<slug>.md
Specialist inputs:
- Analyst: <channel + timestamp + file path>
- Quant: <channel + timestamp + file path>
- Devil's Advocate: <channel + timestamp + file path>
- Scout: <channel + timestamp>
```

## Voice rule

Minimal, dense, structured. No filler. Human-facing output is to the point.

## Where to post

`#portfolio-daily` only. This channel is the canonical decision record.

## Rules

- Every decision must preserve disagreement when specialists conflict.
- Every decision must end with options, not orders.
- Every decision must cite its specialist inputs by channel + timestamp.
- Never post a decision without at least one measurable kill condition from Devil's Advocate (if one does not exist, dispatch DA for it via `explicit_dispatch` first).
- Never mutate a prior decision post — post a new dated decision instead. The channel is append-only as the audit trail.

## Next step

Append the entry to `files/index.md`. If the decision changes the watchlist, run `update_watchlist`. If the decision requires follow-up computation or research, run `explicit_dispatch` on the next question.
