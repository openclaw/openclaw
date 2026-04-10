---
name: weekly_outlook
description: Produce a Sunday-evening two-section post to #weekly-outlook covering what happened this past week and the red-folder calendar for the week ahead. Trigger on the Sunday 17:00 ET scheduled job.
---

# Weekly Outlook

Two-section weekly wrap + look-ahead for the desk. Runs once per week.

## Trigger

- Scheduled job: `0 17 * * 0` America/New_York (Sunday evening).
- Manual invocation by Orchestrator.

## Inputs

- Past week's `#market-signals` tail.
- Past week's `#portfolio-daily` tail (what the team actually decided).
- Past week's earnings tracker files.
- Macro calendar for the coming week from Fed + BLS + BEA + Treasury Direct.
- Major earnings for the coming week from IR calendars.

## Steps

1. **Section A — past week.** Compose a dense recap: key index moves, sector leadership, surprise earnings (from the tracker), macro prints, Fed actions, any decisions the team made this week. Cite via `source_and_confidence` + `approved_sources`.
2. **Section B — week ahead (red-folder calendar).** List every high-impact scheduled event:
   - Macro: CPI, PPI, PCE, FOMC, NFP, JOLTS, Jobless claims, GDP, Treasury auctions.
   - Fed: scheduled speakers + communications windows.
   - Earnings: major reports with date + time (BMO/AMC).
   - Other: options expirations, index rebalances.
   All times in America/New_York.
3. Save the full outlook as `files/YYYY-MM-DD/weekly-outlook-<YYYYMMDD>.md` via `file_layout_discipline`.
4. Post to `#weekly-outlook` with the format below.

## Output format (Slack post)

```
[weekly] outlook <YYYY-MM-DD>

== What happened ==
- <index moves> (source)
- <sector leaders / laggards> (source)
- <notable earnings> (source)
- <macro prints> (source)
- <team decisions this week from #portfolio-daily>

== Week ahead (ET) ==
Macro:
- <DOW HH:MM>  <event>  (consensus if available)
- ...
Fed:
- <DOW HH:MM>  <speaker | FOMC>
Earnings:
- <DOW BMO|AMC>  <TICKER>
- ...

File: files/YYYY-MM-DD/weekly-outlook-<date>.md
Confidence: <High|Medium|Low>
```

## Where to post

`#weekly-outlook` only. This is the dedicated channel; do not cross-post.

## Rules

- Only cite from `approved_sources`. Reuters is denied — do not sneak it in.
- The look-ahead is facts-only. No "expect this, expect that." Scout reports; it does not forecast.
- Keep both sections dense; the whole post should fit on one screen.

## Next step

Append the entry to `files/index.md`. Devil's Advocate or Orchestrator may react with follow-ups in `#weekly-outlook` — answer in-channel.
