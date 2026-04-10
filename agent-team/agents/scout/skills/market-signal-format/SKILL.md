---
name: market_signal_format
description: Format a single market signal (price move, volume anomaly, earnings beat, filing, macro print) as a structured post for #market-signals. Trigger whenever Scout is about to report one observation.
---

# Market Signal Format

Standard structure for a single signal post in `#market-signals`.

## Trigger

You (Scout) are about to report exactly one observation: a price move, volume anomaly, earnings beat/miss, new SEC filing, macro print, halt, upgrade/downgrade, or scheduled-scan hit.

## Inputs

- Ticker (or macro event label).
- Observation: what changed, by how much, versus what baseline.
- Timestamp (America/New_York).
- Source (must pass `approved_sources`).

## Steps

1. Confirm you are reporting facts, not interpretation. If you feel a "bullish/bearish" urge, drop it.
2. Look up the channel ID for `#market-signals` via `channel_directory`.
3. Compose the post using the output format below.
4. Decorate the source line via `source_and_confidence` + `approved_sources`.
5. Decide urgency: if the signal is outside normal range, breaking, or directly hits a `#watchlist` name, tag `@Orchestrator - Portfolio Manager`. Otherwise stop — Orchestrator reads the channel.
6. If the signal is a scheduled-scan hit, also save the full scan artifact via `file_layout_discipline` under `files/YYYY-MM-DD/signals-<scan>.md` and cite the file path in the post.

## Output format

```
[signal] <TICKER or macro label>  <HH:MM ET>
<one-line observation with number + baseline>
Source: <publication, date, url or file path>
Confidence: <High|Medium|Low>
```

Urgent variant prepends `@Orchestrator - Portfolio Manager` on its own line at the top.

## Where to post

`#market-signals` only. Never editorialize in `#portfolio-daily` or `#research`.

## Rules

- One signal per post. If you have five hits from a scan, post five separate signals or one scan-summary post with a file pointer — never a wall of bullets with no structure.
- No interpretation. No "bullish," no "bearish," no "this could mean…"
- If a feed is down, say so explicitly in `#market-signals` — never fabricate.

## Next step

Append a one-line entry to `files/index.md` if you saved an artifact. If Devil's Advocate asks a follow-up in `#market-signals`, answer in-channel (expected; see `follow_up_questions` on the DA side).
