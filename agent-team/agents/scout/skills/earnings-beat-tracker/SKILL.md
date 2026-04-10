---
name: earnings_beat_tracker
description: Track companies that beat or missed earnings each day and maintain a rolling 7-day tracker posted to #market-signals. Trigger on the 17:00 ET scheduled job on market days.
---

# Earnings Beat Tracker

Rolling 7-day record of who beat, who missed, by how much, and reaction. Answers Rob's "who beat earnings today, track day to day" ask.

## Trigger

- Scheduled job: `0 17 * * 1-5` America/New_York.
- Manual invocation by Orchestrator.

## Inputs

- Today's earnings releases from company IR pages and SEC EDGAR 8-K filings.
- Consensus estimates from an approved-sources publication (WSJ, Bloomberg, FT).
- Intraday reaction (close vs prior close, relative to SPY).
- Prior 6 days of this tracker (from your own `files/YYYY-MM-DD/earnings-tracker-*.md` archive via `files/index.md`).

## Steps

1. Pull today's post-close (and this-morning pre-open) earnings releases.
2. For each, record: ticker, EPS actual vs consensus, revenue actual vs consensus, any guidance change, management tone from the transcript if available, reaction today vs SPY.
3. Classify: `beat`, `miss`, `mixed`, `inline`.
4. Append today's rows to the rolling tracker. The tracker is a 7-day window — oldest day drops off.
5. Save the full tracker as `files/YYYY-MM-DD/earnings-tracker-<YYYYMMDD>.md` via `file_layout_discipline`.
6. Post the day's summary + a link to the tracker to `#market-signals`.
7. If any beat/miss is on a `#watchlist` name, tag `@Orchestrator - Portfolio Manager`.

## Output format (Slack post)

```
[earnings] <YYYY-MM-DD>  beats: <n>  misses: <n>  mixed: <n>
Notables today:
- <TICKER>  EPS <actual vs est>  Rev <actual vs est>  reaction <+/-n% vs SPY>  guidance <raise|cut|hold>
- ...
7-day rolling tracker: files/YYYY-MM-DD/earnings-tracker-<date>.md
Confidence: <High|Medium|Low>
```

## Where to post

`#market-signals`. The tracker file itself lives in your workspace; other agents pull via A2A if needed.

## Rules

- Pull EPS/revenue from company IR or SEC EDGAR, never from a wire aggregator.
- Consensus numbers must come from an `approved_sources` publication.
- Never call a beat on non-GAAP alone — report both if they diverge.
- If a transcript is not yet posted, say so and skip the tone column.

## Next step

Append the entry to `files/index.md`. If a beat/miss is on a watchlist name and the reaction is material, also post a single-signal alert via `market_signal_format`.
