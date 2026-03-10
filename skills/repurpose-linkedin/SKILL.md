---
name: repurpose-linkedin
description: Convert a Medium article into LinkedIn posts. Use when asked to repurpose content for LinkedIn, create social posts, or turn an article into short-form content. Produces 3 distinct LinkedIn post variants (insight, story, question) from an existing article draft.
metadata:
  openclaw:
    emoji: "💼"
---

# Repurpose for LinkedIn

Converts a Medium article draft into 3 distinct LinkedIn post variants.

## When to Use

- "repurpose for linkedin"
- "create linkedin posts from article"
- "turn article into social posts"
- "linkedin variants"

## Source

Reads from: `outputs/content/article.md`
Voice rules from: `memory/brand/writing_style.md`

## Three Variants

- **Variant 1 — The Insight**: Bold statement leading with the core thesis
- **Variant 2 — The Story**: Opens with a concrete example or case study
- **Variant 3 — The Question**: Opens with a provocative question the article answers

## Post Rules

- First line must work standalone (no "I recently wrote..." openers)
- 150–250 words per post
- Short paragraphs (1–2 sentences)
- End with a question or clear point of view
- Max 3 relevant hashtags at the end

## Output Format

```
# LinkedIn Posts — [Article Title]

## Variant 1 — The Insight
[Post]
#tag1 #tag2 #tag3

## Variant 2 — The Story
[Post]
#tag1 #tag2 #tag3

## Variant 3 — The Question
[Post]
#tag1 #tag2 #tag3
```

Save to: `outputs/content/linkedin-posts.md`

## After Output

Remind the author:

> After posting on LinkedIn, run `collect feedback` and paste the final post you used so your writing style updates from the edits you made.
