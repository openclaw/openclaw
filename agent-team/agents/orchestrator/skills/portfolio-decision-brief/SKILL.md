---
name: portfolio_decision_brief
description: Synthesize specialist inputs into a portfolio-aware decision brief for the human operator, preserving disagreement and listing options not orders. Trigger when enough specialist input has landed to frame a decision and the operator is waiting.
---

# Portfolio Decision Brief

The final human-facing synthesis. Dense, structured, minimal filler. This skill is paired with `publish_daily_brief` — this one composes the brief, the other publishes it to `#portfolio-daily`.

## Trigger

You (Orchestrator) have enough specialist input to frame a decision for the human:
- Analyst posted a decision-grade thesis in `#research`.
- Quant posted corroborating or conflicting signals in `#quant-signals`.
- Devil's Advocate posted a stress-test verdict in `#contrarian` with kill conditions.
- Scout posted any relevant triggers in `#market-signals`.
- The human operator is waiting.

## Inputs

- Tails of `#research`, `#quant-signals`, `#contrarian`, `#market-signals` for the relevant ticker/theme.
- Relevant artifacts pulled via `a2a_artifact_pull` from specialist `files/` folders (backtest JSON, research markdown).
- `#watchlist` tail to confirm portfolio context.
- `shared/portfolio/positions.md` loaded on demand.
- `#portfolio-daily` tail for continuity with prior decisions.

## Steps

1. Gather specialist inputs. If any load-bearing input is missing, dispatch a targeted question via `explicit_dispatch` and stop — do not brief on incomplete inputs.
2. Compose the brief using the output format below.
3. Preserve disagreement. If Analyst and Devil's Advocate conflict, state the conflict and which side is more persuasive and why. Never force consensus.
4. Cite inputs inline with specialist + timestamp. Decorate factual claims via `source_and_confidence`.
5. End with **options**, not orders. The human makes the call.
6. Save the brief file to `files/YYYY-MM-DD/brief-<slug>.md` via `file_layout_discipline`.
7. Hand off to `publish_daily_brief` for the Slack post to `#portfolio-daily`.

## Output format

```
[brief] <TICKER or theme>  <date>
Thesis: <one sentence>
Bull case: <two bullets max, each with specialist citation>
Bear case: <two bullets max, each with specialist citation>
Conflicting inputs: <if any, stated plainly>
Missing evidence: <what would raise confidence>
Portfolio fit: <overlap, concentration, sizing considerations>
Kill conditions: <from Devil's Advocate, measurable>
Confidence: <High|Medium|Low>
Options:
  1. <action + rationale>
  2. <action + rationale>
  3. <do nothing + rationale>
```

## Voice rule

Human-facing output is minimal and to the point. Dense structure, no filler, no hedging phrases. If a point does not change the decision, cut it.

## Where to post

This skill writes the file. `publish_daily_brief` posts to `#portfolio-daily` — that channel IS the canonical decision record. There is no `recent-decisions.md`.

## Rules

- Preserve disagreement.
- End with options, not orders.
- If evidence is incomplete, say what is missing instead of forcing certainty.
- Include portfolio concentration / overlap context.
- Never reopen a closed decision without new evidence.

## Next step

Invoke `publish_daily_brief` to post the pointer + options to `#portfolio-daily`. Append the row to `files/index.md`.
