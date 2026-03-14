---
name: build-source-pack
description: Build a research pack for a given topic. Use when asked to research a topic, gather evidence, find sources, or prepare background material for an article. Collects data points, case studies, quotes, and key findings from the past 12 months.
metadata:
  openclaw:
    emoji: "📦"
---

# Build Source Pack

Assembles a comprehensive research pack for a given topic, ready to feed into article drafting.

## When to Use

- "build source pack on [topic]"
- "research [topic]"
- "gather evidence for [topic]"
- "find sources about [topic]"

## Process

1. Search for recent signals (past 12 months) on the topic
2. Extract: data points, case studies, company examples, practitioner quotes
3. Identify 3 article angles (provocative, contrarian, practical)

## Output Format

```
# Research Pack — [Topic]

## Summary
[3–4 sentence landscape overview]

## Key Findings
- [Finding + source]

## Evidence
### Data Points
- [Stat: source, date]

### Case Studies
- [Company: what happened, outcome]

### Quotes
- "[Quote]" — Name, Title

## Sources

## Article Angles
- The provocative take
- The contrarian take
- The practical take
```

Save to: `outputs/content/source-pack.md`
