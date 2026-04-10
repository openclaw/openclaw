---
name: file_layout_discipline
description: Write every artifact into your own workspace under files/YYYY-MM-DD/ with a category prefix, then append a row to files/index.md. Trigger on every file you are about to write.
---

# File Layout Discipline

You share this computer with four other agents. Without discipline, files collide, clutter, and drift. Every file you produce goes into your own workspace under a dated subfolder, with a category prefix, and is indexed.

## Trigger

About to write any file (markdown, json, csv, txt) as part of executing a skill.

## Inputs

- The content you are about to write.
- Today's date in `YYYY-MM-DD` (America/New_York).
- A category prefix from your agent's palette (below).
- A short slug describing the artifact.

## Category prefixes by agent

| Agent | Prefixes |
|---|---|
| Orchestrator | `brief-`, `dispatch-`, `watchlist-`, `decision-`, `weekly-` |
| Scout | `signals-`, `watchlist-`, `weekly-outlook-`, `earnings-`, `calendar-` |
| Analyst | `research-`, `thesis-`, `valuation-`, `filings-` |
| Quant | `quant-`, `backtest-`, `signals-`, `method-` |
| Devil's Advocate | `risk-`, `stress-`, `kill-`, `overlap-`, `review-` |

## Steps

1. Compute today's date folder: `files/YYYY-MM-DD/`. Create it if it does not exist.
2. Pick the category prefix that best describes the artifact.
3. Pick a short slug: lowercase, hyphen-separated, descriptive (`nvda`, `cpi-apr`, `portfolio-overlap`).
4. Compose filename: `<category>-<slug>.<ext>` (e.g. `research-nvda.md`, `quant-backtest-spy.json`).
5. Write the file at `files/YYYY-MM-DD/<filename>`.
6. Append one line to `files/index.md`:

   ```
   YYYY-MM-DD HH:MM  <category>-<slug>.<ext>  <one-line summary of what's in it>
   ```

7. If you wrote multiple files in one skill run, append one row per file.

## Session-start rule

At the start of every session, after reading `MEMORY.md`, scan the last ~5 entries in `files/index.md`. This reconstructs recent operating state cheaply without rereading full artifacts. Every 5 sessions (or after a weekend gap), scan the last ~20 entries and summarize into the new MEMORY.md entry.

## Output format

No output — this skill is a filesystem protocol. It runs as a side effect of another skill that produces content.

## Where to post

Nowhere. Files live on disk. If another agent needs an artifact, they pull it via A2A (see `a2a_artifact_pull`) after you post a short pointer in the appropriate Slack channel.

## Next step

Return to the skill that triggered this one. After posting the Slack pointer, the round-trip is complete.
