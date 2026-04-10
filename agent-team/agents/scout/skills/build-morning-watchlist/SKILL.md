---
name: build_morning_watchlist
description: Build the pre-market watchlist of ranked movers, unusual volume, fresh earnings beats, new SEC filings, and scheduled macro events, then post it to #watchlist for Orchestrator approval. Trigger on the 06:30 ET scheduled job on market days.
---

# Build Morning Watchlist

The day's ranked coverage list. Scout rebuilds it each pre-market; Orchestrator approves and maintains it through the day.

## Trigger

- Scheduled job: `30 6 * * 1-5` America/New_York.
- Manual invocation by Orchestrator via `#dispatch` ("rebuild morning watchlist now").

## Inputs

- Pre-market mover feed (from approved source).
- Unusual-volume screen (pre-market + overnight).
- Prior-close earnings beats/misses.
- Fresh SEC filings (8-K, 13D/G, S-1, 10-Q, 10-K) overnight.
- Macro calendar for today: CPI, PPI, FOMC, NFP, Fed speakers, Treasury auctions.
- Yesterday's `#watchlist` tail (continuity).

## Steps

1. Pull pre-market movers: top +/- 3% with dollar-volume above a reasonable floor.
2. Pull unusual-volume screen overnight.
3. Pull prior-close earnings beats from company IR pages and SEC EDGAR 8-K filings.
4. Pull overnight 8-K / 13D/G filings from SEC EDGAR.
5. Pull today's macro calendar from Fed + BLS + BEA + Treasury Direct.
6. Rank all hits by a simple composite: absolute move × volume anomaly × catalyst density. Keep the top 15.
7. Preserve names from yesterday's `#watchlist` that are still relevant (continuity).
8. Save the full artifact as `files/YYYY-MM-DD/watchlist-morning.md` via `file_layout_discipline` — include every hit, the screen parameters, and the data-source list for audit.
9. Compose the post using the output format below.
10. Post to `#watchlist` and tag `@Orchestrator - Portfolio Manager` for approval.

## Output format (Slack post)

```
@Orchestrator - Portfolio Manager  [morning-watchlist] <YYYY-MM-DD>
Top names (ranked):
1. <TICKER>  <+n.n% pre>  <vol x baseline>  <catalyst>
2. ...
...
Macro today (ET):
- <HH:MM>  <event>
- ...
Carried from yesterday: <tickers>
Dropped: <tickers + reason>
File: files/YYYY-MM-DD/watchlist-morning.md
Confidence: <High|Medium|Low>
```

## Where to post

`#watchlist` only. This channel IS the canonical active coverage list — there is no `watchlist.md` file anywhere.

## Rules

- Facts only. No interpretation.
- Every source must pass `approved_sources` (Reuters denied).
- If a data feed is down, say so explicitly and rebuild with what you have — never fabricate.
- Never add or remove names unilaterally once Orchestrator has accepted the morning list. After approval, only Orchestrator mutates `#watchlist` via `update_watchlist`.

## Next step

Append the entry to `files/index.md`. Orchestrator will either accept the list as-is or reply in `#watchlist` with changes. If Devil's Advocate asks a follow-up in `#watchlist`, answer in-channel. Then begin `scan_pre_market` on the approved list.
