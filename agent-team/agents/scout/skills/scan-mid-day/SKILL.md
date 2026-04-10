---
name: scan_mid_day
description: Run the mid-day window scan on watchlist names and post hits to #market-signals. Trigger on the 12:00 ET scheduled job on market days.
---

# Scan — Mid-Day

Window: 09:30–13:00 ET. Runs at lunch to flag intraday breaks, reversals, and mid-session catalysts.

## Trigger

- Scheduled job: `0 12 * * 1-5` America/New_York.
- Manual invocation.

## Inputs

- Current `#watchlist` tail (may have been updated by Orchestrator since pre-market).
- Intraday quotes + volume for each name.
- Intraday news since open from `approved_sources`.
- Any `#quant-signals` posts since open (for context).

## Steps

1. Read current `#watchlist` tail.
2. For each name: measure move vs open, vs prior close, volume vs 20-day session pace.
3. Hits: |move vs open| ≥ 2% OR session volume pace ≥ 2× OR new 8-K / press release intraday OR trading halt.
4. Check for reversals (morning leaders now red, morning laggards now green).
5. Save scan artifact to `files/YYYY-MM-DD/signals-mid-day.md` via `file_layout_discipline`.
6. Post summary to `#market-signals`.
7. Emit standalone `market_signal_format` alerts for anything outside normal range.

## Output format (Slack post)

```
[scan] mid-day  <YYYY-MM-DD>  HH:MM ET
Hits (<n>):
- <TICKER>  <move vs open>  pace <x>  <catalyst | "no news">
Reversals:
- <TICKER>  <morning -> now>
File: files/YYYY-MM-DD/signals-mid-day.md
Confidence: <High|Medium|Low>
```

## Where to post

`#market-signals`.

## Rules

- Facts only.
- `approved_sources` for every catalyst.
- Never fabricate when a feed is down — say so.

## Next step

Append to `files/index.md`. Stand by for the post-market scan.
