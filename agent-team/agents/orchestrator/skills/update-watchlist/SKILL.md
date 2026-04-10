---
name: update_watchlist
description: Publish a canonical watchlist change (add, drop, rationale) to the #watchlist Slack channel. Trigger whenever the Orchestrator needs to mutate active coverage outside the Scout morning rebuild.
---

# Update Watchlist

The `#watchlist` channel is the canonical active coverage list. There is no `watchlist.md`. Scout rebuilds it each morning via `build_morning_watchlist`; you mutate it during the day via this skill.

## Trigger

- A thesis from Analyst or Quant becomes decision-grade and the ticker belongs on the watchlist.
- A Devil's Advocate review trips a kill condition and a ticker comes off.
- A macro or sector rotation changes which names the desk is tracking.
- The operator explicitly asks for a change.

## Inputs

- The change: add, drop, or rationale update.
- The ticker.
- The rationale in one line.
- The triggering artifact (a research file, a stress test, a signal) if any.

## Steps

1. Read the last ~20 messages in `#watchlist` to confirm current state.
2. Compose the update using the output format below. One change per post — if you have three adds and two drops, that's five posts.
3. Decorate with `source_and_confidence` where relevant.
4. Save the update as `files/YYYY-MM-DD/watchlist-update-<HHMM>.md` via `file_layout_discipline` — audit trail.
5. Post to `#watchlist`.

## Output format

```
[watchlist] <add | drop | note>  <TICKER>
Rationale: <one line>
Trigger: <file path or specialist + channel + timestamp>
Confidence: <High|Medium|Low>
```

## Where to post

`#watchlist` only. Specialists read this channel on startup; that's how coverage propagates.

## Rules

- One change per post. Never batch into a wall of bullets.
- Only you publish canonical changes. Scout's morning rebuild is the only other permitted writer, and it runs once per day.
- Never drop a ticker silently — always include rationale.
- Never add a ticker without a trigger (specialist work, signal, or explicit operator ask).

## Next step

Append the entry to `files/index.md`. If the add or drop materially changes the portfolio lineup, feed it into `publish_daily_brief` for the day's record in `#portfolio-daily`.
