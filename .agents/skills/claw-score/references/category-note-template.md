# Category Note Template

Use this template for every per-category maturity note.

```markdown
---
title: <Surface> - <Category> Maturity Note
version: <PROCESS_VERSION>
last_refreshed: YYYY-MM-DD
last_refreshed_by: codex
---

# <Surface> - <Category> Maturity Note

## Summary

## Category Scope

## Features

- <Feature name>: <Feature description>

## Archive Freshness

- gitcrawl:
- discrawl:
- discrawl scope: `clawtributors` and public channels only; maintainer-only and private security channels excluded

## Coverage Score

- Score: `<MaturityLabel> (<N>%)`
- Positive signals:
- Negative signals:
- Integration gaps:

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the category. Unit tests can provide supporting context but never make a feature
covered by themselves.

## Quality Score

- Score: `<MaturityLabel> (<N>%)`
- Gitcrawl reports:
- Discrawl reports:
- Good qualities:
- Bad qualities:
- Excluded from quality:

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `<MaturityLabel> (<N>%)`
- Surface instructions:
- Positive signals:
- Negative signals:
- Missing capability branches:

Completeness labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended
surface-specific capability set. The exact rubric comes from the scoring
surface's taxonomy `completeness_instructions` file.

## Known Gaps

## Evidence

### Docs

-

### Source

-

### Integration tests

-

### Unit tests

-

### Surface validation commands

- `<command>`: `<pass|fail|blocked>` - `<what the result means for this category>`

### Gitcrawl queries

Query:

Results:

-

### Discrawl queries

Scope:

- `clawtributors` and public channels only
- excluded: maintainer-only channels
- excluded: private security channels

Query:

Results:

-
```
