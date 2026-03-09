---
name: content-scan
description: Scan for thought leadership article ideas. Use when asked to find content ideas, generate article topics, scan for trending themes in AI and technology, or brainstorm what to write about. Produces top 5 article ideas ranked by relevance and timeliness for a technology/business executive audience.
metadata:
  openclaw:
    emoji: "🔍"
---

# Content Scan

Identifies the top 5 thought leadership article ideas based on current signals in AI, enterprise technology, and business strategy.

## When to Use

- "content scan"
- "what should I write about"
- "find me article ideas"
- "scan for trending topics"
- "give me 5 ideas"

## Process

1. Identify emerging themes from the past 2 weeks in AI and technology
2. Score each theme: relevance to technology leaders, timeliness, originality
3. Generate 5 article ideas with working title, core insight, and why it matters now

## Output Format

```
# Top 5 Article Ideas — [Date]

## 1. [Title]
Why now: [1 sentence]
Core insight: [1–2 sentences]
Audience hook: [What makes leaders stop and read]

## 2–5 ...
```

Save output to: `outputs/content/ideas.md`

## Voice

Read `memory/brand/writing_style.md` to ensure ideas match the author's audience and tone.

## After Output

Confirm save location and highlight the strongest idea with a one-line reason why.
