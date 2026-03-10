---
name: collect-feedback
description: "Closes the content pipeline feedback loop after a Medium article or LinkedIn post has been published. Provide the published Medium URL and/or the final LinkedIn post text you actually used. Compares the published version against the original draft, extracts style and structural learnings from your edits, and updates memory/brand/writing_style.md so future drafts need fewer edits. Also logs each round to memory/brand/feedback-log.md. Trigger after publishing: 'collect feedback [medium URL]', 'I posted, here is what I changed', or 'update writing style from my Medium post'."
metadata:
  openclaw:
    emoji: "🔁"
---

# Collect Feedback

Learns from the gap between draft and final published post. Updates writing style memory so each draft cycle improves.

## When to Use

- "collect feedback [Medium URL]"
- "I posted the article, here's what I changed: ..."
- "update writing style from my Medium post"
- "learn from what I published"

## Inputs

Accept one or both of:

1. **Medium URL** — fetch and read the final published article
2. **Final LinkedIn post text** — paste the variant that was actually used

If neither is provided, ask for at least one before proceeding.

## Process

### Step 1 — Load originals

Read:

- `outputs/content/article.md` — original draft
- `outputs/content/linkedin-posts.md` — original LinkedIn variants

If files are missing, note it and proceed with what is available.

### Step 2 — Load finals

- If Medium URL provided: fetch the full article text from the URL
- If LinkedIn text provided: use as-is

### Step 3 — Compare and extract learnings

Analyse the diff between original draft and final published version across these dimensions:

**Article (Medium):**

- Title: was it changed? How? (shorter, punchier, different angle)
- Hook: was the first sentence/paragraph edited? What pattern?
- Structure: sections added, removed, reordered?
- Length: longer or shorter than the draft?
- Voice: any recurring word substitutions or phrase replacements?
- Evidence: did the author add or cut specific examples/data?
- Conclusion: was the ending changed?
- Visuals: did the author add images/media manually? (note as recurring behaviour)

**LinkedIn:**

- Which variant was used (Insight / Story / Question)?
- How was the hook edited?
- Was the length changed?
- Were hashtags changed?
- Was the CTA changed?

### Step 4 — Generate learnings

Summarise edits as actionable style rules. Format each learning as:

```
- [What to do differently]: [specific pattern observed]
```

Examples:

- Shorten titles: author consistently trims titles to under 8 words
- Strengthen hooks: first sentence is always rewritten to remove scene-setting
- LinkedIn preference: Variant 2 (Story) is consistently chosen over Insight
- Add images: author always adds a visual manually — include an image suggestion in drafts

### Step 5 — Update writing style memory

Append learnings to `memory/brand/writing_style.md` under a `## Learned from Published Posts` section.
If the section already exists, append new learnings without duplicating existing ones.

### Step 6 — Log the feedback round

Append to `memory/brand/feedback-log.md`:

```
## [Date] — [Article title or slug]

**Medium:** [URL or "not provided"]
**LinkedIn variant used:** [Insight / Story / Question / unknown]

### Edits observed
[bullet list of specific changes]

### Learnings added to writing_style.md
[bullet list of rules added]
```

Create the file if it does not exist.

### Step 7 — Confirm

Reply with:

- Number of learnings extracted
- 3 most impactful style rules added
- Confirmation that writing_style.md and feedback-log.md were updated
