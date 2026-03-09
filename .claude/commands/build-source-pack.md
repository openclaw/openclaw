Build a research pack for the given topic using the researcher subagent.

$ARGUMENTS

If no topic is provided, read `outputs/content/ideas.md` and use the top-ranked idea.

Process:

1. Use the researcher subagent to gather evidence, signals, and sources
2. Focus on the past 12 months of content
3. Prioritize: specific data points, real case studies, named company examples, practitioner quotes

Output format:

```
# Research Pack — [Topic]
Generated: [Date]

## Summary
[3–4 sentence overview of the landscape]

## Key Findings
- [Finding 1 + source]
- [Finding 2 + source]
- [Finding 3 + source]
- [Finding 4 + source]
- [Finding 5 + source]

## Supporting Evidence
### Data Points
- [Stat: source, date]

### Case Studies
- [Company/example: what happened, outcome]

### Quotes
- "[Quote]" — [Name, Title, Source]

## Sources
- [Full references]

## Angles for Article
- [Angle 1 — the provocative take]
- [Angle 2 — the contrarian take]
- [Angle 3 — the practical take]
```

Save to `outputs/content/source-pack.md` (overwrite if exists).
Confirm when saved.
