---
name: equity_research_report
description: Produce a full, source-backed equity research report on a single ticker and save it as a file with a short Slack pointer. Trigger on any Orchestrator dispatch asking for a thesis on a named company.
---

# Equity Research Report

Full fundamental thesis on one ticker. Lives as a file; Slack gets a pointer.

## Trigger

You (Analyst) received an Orchestrator dispatch asking for a thesis on a named company, or a watchlist name hit a signal that requires a full writeup.

## Inputs

- Ticker and the specific question from Orchestrator (or the triggering signal).
- Most recent 10-K, 10-Q, 8-K from SEC EDGAR.
- Most recent earnings release and transcript from company IR.
- Any relevant context from `#market-signals` or `#quant-signals`.

## Steps

1. Pull primary filings from SEC EDGAR (always) and IR pages. Never start from a wire story.
2. Compose the report using the output structure below. Separate sourced fact from inference explicitly — prefix inference with `inference:`.
3. Decorate every claim via `source_and_confidence` + `approved_sources`.
4. Save the full report to `files/YYYY-MM-DD/research-<ticker>.md` via `file_layout_discipline`.
5. Post a short pointer to `#research` using the pointer format below.
6. Decide whether this is decision-grade. If yes, tag `@Devil's Advocate - Risk & Contrarian` in the pointer. If it changes a position, also tag `@Orchestrator - Portfolio Manager`. Otherwise tag neither — Orchestrator reads the channel.

## Report structure (the file)

1. **Why now** — the trigger, one paragraph.
2. **Business model** — revenue streams, unit economics, geography.
3. **Financial health** — revenue trend, margins, cash flow, leverage, cash + liquidity, any aggressive accounting flags (see `finance_focused`).
4. **Competitive position** — moat, share, pricing power, key competitors.
5. **Customer concentration** — top customers, contracts, renewal risk.
6. **Management and governance** — tenure, alignment, related-party issues.
7. **Catalysts** — forward events, dates in ET.
8. **Risks** — structural + cyclical, separated.
9. **Valuation context** — multiples vs history + peers; DO NOT propose a price target unless explicitly asked.
10. **Bear case** — concise, even if your lean is positive.
11. **Open questions** — what would raise or lower confidence.

## Pointer format (the Slack post)

```
@<recipients, if any>  [research] <TICKER>  <one-line verdict>
File: files/YYYY-MM-DD/research-<ticker>.md
Sources: <top 3, Fact→Source→Confidence decorated>
Open questions: <one or two lines>
```

## Where to post

`#research` only.

## Rules

- No unsourced facts. No Reuters. Prefer SEC EDGAR + IR over any wire.
- No wall-of-text in Slack — the report goes in the file.
- Include a bear case even if your lean is positive.
- Never propose a price target unless the dispatch explicitly asked.

## Next step

Append the entry to `files/index.md`. If you tagged Devil's Advocate, expect a follow-up in `#research`; answer in-channel. If DA returns kill conditions, update the file with a note and repost the pointer if material.
