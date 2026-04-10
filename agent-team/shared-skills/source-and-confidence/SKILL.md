---
name: source_and_confidence
description: Attach a source and a High/Medium/Low confidence label to every factual claim, recommendation, or unresolved question before posting. Trigger on any outbound message that contains facts, numbers, or a recommendation.
---

# Source and Confidence

Every factual claim, number, recommendation, or unresolved question you post MUST carry a source and a confidence label. This is the universal Fact → Source → Confidence pattern used across the whole team.

## Trigger

About to post a message (Slack, file, or brief) that contains any of:
- A factual claim about a company, market, macro event, or data series.
- A number you computed or read from a source.
- A recommendation, thesis, or stance.
- An unresolved question where the answer would change a decision.

## Inputs

- The claim itself, in one sentence.
- The source you read it from (must appear on the `approved_sources` allowlist).
- Your current confidence after examining the evidence.

## Steps

1. State the fact in one sentence.
2. Cite the source inline: publication, date, and a URL or docket reference. If you're posting in Slack and the source is long, save the excerpt to `files/YYYY-MM-DD/` and link the file path.
3. Label confidence using the ladder below.
4. If the claim is actually inference (not sourced), label it `inference:` explicitly. Never pass inference off as fact.
5. If a claim cannot be verified, say `unable to verify` and drop confidence to Low.
6. If two sources conflict, state the conflict and rank source quality against `approved_sources`. Never collapse disputed facts into one unsupported statement.

## Confidence ladder

- **High** — strong evidence from multiple reliable sources, or direct computation on real data with methodology shown.
- **Medium** — partial evidence, one reliable source, or some open questions remain.
- **Low** — thin data, single weak source, incomplete sourcing, or unresolved uncertainty.

## Rules

- Apply confidence to the claim, not to your mood.
- Lower confidence when important evidence is missing or in conflict.
- Do not label a recommendation High if key assumptions remain untested.
- If abnormal volatility is flagged by Quant, apply the emotion-regulation notch-down rule from `emotion_regulation`.

## Output format

```
Fact: <one sentence>
Source: <publication, date, URL or file path>
Confidence: <High|Medium|Low>
```

For inference:

```
Inference: <one sentence>
Based on: <what you reasoned from>
Confidence: <High|Medium|Low>
```

## Where to post

Wherever you were already going to post the claim — this skill decorates the message, it doesn't change the destination.

## Next step

Post the message. If confidence is Low on something that would change a decision, also tag `@Orchestrator - Portfolio Manager` (or `@Devil's Advocate - Risk & Contrarian` if you're already in a review thread) so the weak link is visible.
