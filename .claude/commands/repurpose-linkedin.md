Convert the existing Medium article draft into 3 LinkedIn post variants.

Read `outputs/content/article.md` for the source article.
Read `memory/brand/writing_style.md` for voice and style rules.

Create 3 distinct variants — each must feel fresh, not like a repeat:

- **Variant 1 — The Insight**: Lead with the core thesis as a bold statement. No preamble.
- **Variant 2 — The Story**: Lead with a concrete example or case study from the article.
- **Variant 3 — The Question**: Lead with a provocative question that the article answers.

LinkedIn post rules:

- First line must work standalone (no "I recently wrote..." openers)
- 150–250 words per post
- Max 5 lines before natural break
- Short paragraphs — 1–2 sentences
- End with either a question to the audience OR a clear point of view
- Max 3 hashtags, placed at the end

Output format:

```
# LinkedIn Posts — [Article Title]
Generated: [Date]

---

## Variant 1 — The Insight
[Post text]

#hashtag1 #hashtag2 #hashtag3

---

## Variant 2 — The Story
[Post text]

#hashtag1 #hashtag2 #hashtag3

---

## Variant 3 — The Question
[Post text]

#hashtag1 #hashtag2 #hashtag3
```

Save to `outputs/content/linkedin-posts.md` (overwrite if exists).
Confirm when saved and print Variant 1.
