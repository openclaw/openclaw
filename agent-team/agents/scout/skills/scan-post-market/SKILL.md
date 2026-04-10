---
name: scan_post_market
description: Run the post-market window scan on watchlist names and post hits to #market-signals. Trigger on the 16:30 ET scheduled job on market days.
---

# Scan — Post-Market

Window: 16:00–20:00 ET. Runs after the close to capture session close, after-hours moves, post-close earnings, and 8-K filings.

## Trigger

- Scheduled job: `30 16 * * 1-5` America/New_York.
- Manual invocation.

## Inputs

- Current `#watchlist` tail.
- Session close prices and volume.
- After-hours quotes.
- Post-close 8-K filings and company IR press releases.
- Post-close earnings releases (handoff to `earnings_beat_tracker` at 17:00).

## Steps

1. Read `#watchlist` tail.
2. For each name: record session close (% vs prior close), session volume vs 20-day average, after-hours move if any, any 8-K / press release post-close.
3. Identify hits: |session move| ≥ 2% OR session vol ≥ 2× OR after-hours move ≥ 2% OR post-close 8-K / release.
4. Note which names are reporting earnings post-close (`earnings_beat_tracker` will cover them fully).
5. Save scan artifact to `files/YYYY-MM-DD/signals-post-market.md` via `file_layout_discipline`.
6. Post summary to `#market-signals`.
7. Emit standalone `market_signal_format` alerts for anything outside normal range.

## Output format (Slack post)

```
[scan] post-market  <YYYY-MM-DD>  HH:MM ET
Session close hits (<n>):
- <TICKER>  close <+/-n%>  vol <x baseline>  <catalyst>
After-hours moves:
- <TICKER>  <+/-n% AH>  <catalyst>
Reporting post-close (handing to earnings tracker):
- <TICKERS>
File: files/YYYY-MM-DD/signals-post-market.md
Confidence: <High|Medium|Low>
```

## Where to post

`#market-signals`.

## Rules

- Facts only.
- `approved_sources` on every catalyst.
- Do not duplicate earnings-specific reporting — that is `earnings_beat_tracker`'s job.

## Next step

Append to `files/index.md`. `earnings_beat_tracker` fires at 17:00 ET for the full earnings roundup.
