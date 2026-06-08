# Surface Report Template

Use this template for the aggregate surface report.

```markdown
---
title: <Surface> Maturity Report
version: <PROCESS_VERSION>
last_refreshed: YYYY-MM-DD
last_refreshed_by: codex
---

# <Surface> Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest
whole number.

- Coverage: `<MaturityLabel> (<N>%)`
- Quality: `<MaturityLabel> (<N>%)`
- Completeness: `<MaturityLabel> (<N>%)`
- LTS Features: `<N>/<Total>`

## Summary

## Matrix

| Category | LTS | Coverage | Quality | Completeness | Features to evaluate |
| --- | --- | --- | --- | --- | --- |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching taxonomy
  category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. <Category>

Category note: [<Category>](<category-note>.md)

Score decisions:

- Coverage: `<MaturityLabel> (<N>%)`
- Quality: `<MaturityLabel> (<N>%)`
- Completeness: `<MaturityLabel> (<N>%)`
- LTS: `<✅|❌>`

Search anchors:

-

Features:

-

Primary docs:

-

Major quality/completeness gaps:

-

## Recommended scorecard interpretation

## Out of scope for this surface

## Audit provenance

- Score source:
  `<output-root>/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
```
