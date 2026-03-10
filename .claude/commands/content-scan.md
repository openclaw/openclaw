Scan for the top 5 thought leadership article ideas relevant to AI, enterprise technology, and business strategy.

Use the researcher subagent to:

1. Identify emerging themes from the past 2 weeks in AI and technology
2. Score each theme on: relevance to technology leaders, timeliness, originality, the author's expertise
3. Generate 5 article ideas with a working title, 2-sentence description, and why it matters now

Read `memory/brand/writing_style.md` to ensure ideas match the author's voice and audience.

Output format:

```
# Top 5 Article Ideas — [Date]

## 1. [Title]
**Why now:** [1 sentence]
**Core insight:** [1–2 sentences]
**Audience hook:** [What will make technology leaders stop and read]

## 2. [Title]
...
```

Save the full output to two locations:

1. `outputs/content/ideas.md` — overwrite with latest (used by downstream pipeline steps)
2. `outputs/content/ideas/[YYYY-MM-DD-HH-MM]-[topic-slug].md` — dated archive copy that is never overwritten

The topic slug is a 3-5 word kebab-case summary of the scan topic or top idea title (e.g. `geo-search-cpg-brands`, `ai-governance-enterprise`, `general-scan`).

Confirm both save paths and print the top idea with a one-line summary.
