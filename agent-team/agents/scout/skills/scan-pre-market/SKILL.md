---
name: scan_pre_market
description: Run the pre-market window scan on approved watchlist names and post hits to #market-signals. Trigger on the 08:00 ET scheduled job on market days.
---

# Scan — Pre-Market

Window: 04:00–09:30 ET. Runs after `build_morning_watchlist` has posted and Orchestrator has approved the day's list.

## Trigger

- Scheduled job: `0 8 * * 1-5` America/New_York.
- Manual invocation by Orchestrator.

## Inputs

- Today's approved `#watchlist` (read tail).
- Pre-market quotes for each name.
- Overnight news since 16:00 ET prior day from `approved_sources`.

## Steps

1. Read today's approved watchlist from `#watchlist`.
2. For each name: check pre-market price move, volume, any news since 16:00 prior day.
3. Identify hits: |pre-market move| ≥ 2% OR volume ≥ 3× 20-day pre-market average OR any 8-K / guidance change.
4. Save the full scan to `files/YYYY-MM-DD/signals-pre-market.md` via `file_layout_discipline`.
5. Post the scan summary to `#market-signals` using the format below.
6. For any hit that is outside normal range or breaking news, also emit a standalone `market_signal_format` alert tagging `@Orchestrator - Portfolio Manager`.

## Output format (Slack post)

```
[scan] pre-market  <YYYY-MM-DD>  HH:MM ET
Hits (<n>):
- <TICKER>  <+n.n%>  vol <x baseline>  <one-line catalyst or "no news">
- ...
No-change: <tickers>
File: files/YYYY-MM-DD/signals-pre-market.md
Confidence: <High|Medium|Low>
```

## Where to post

`#market-signals`.

## Rules

- Facts only. No interpretation.
- Every catalyst must cite `approved_sources`.
- If the quote feed is down, say so and post what you have.

## Next step

Append the entry to `files/index.md`. Stand by for the mid-day scan.
