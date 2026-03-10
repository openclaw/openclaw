---
name: draft-medium
description: Generate a full Medium article draft on a given topic. Use when asked to write an article, draft a post, create long-form content, or produce a thought leadership piece. Runs the full researcher → writer → editor pipeline and produces an 800–1200 word article ready for review.
metadata:
  openclaw:
    emoji: "✍️"
---

# Draft Medium Article

Runs the full research-to-draft pipeline and produces a polished Medium article.

## When to Use

- "draft medium on [topic]"
- "write an article about [topic]"
- "create a post on [topic]"
- "draft a thought leadership piece on [topic]"

## Pipeline

```
researcher → gather evidence and signals
writer     → create thesis, structure, and full draft (800–1200 words)
editor     → sharpen for clarity, punch, and readability
```

## Quality Gate

Before saving, verify:

- Hook grabs attention in the first sentence
- Thesis is clear within the first 150 words
- At least 3 pieces of specific evidence
- Actionable takeaway in the conclusion
- No paragraphs over 3 sentences

## Output Format

```
# [Title]

[Full article — 800–1200 words]

---
Sources: [References]
Word count: [N]
Generated: [Date]
```

Save to: `outputs/content/article.md`
Archive copy to: `data/research/[date]-[slug].md`

## Voice

Always read `memory/brand/writing_style.md` before writing.

## After Output

Print title + hook. Confirm save paths.

Remind the author:

> After publishing on Medium, run `collect feedback [your Medium URL]` to update your writing style from the edits you made.
