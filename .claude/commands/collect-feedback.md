Close the content pipeline feedback loop after publishing.

$ARGUMENTS

## What this does

Compares what was published against the original draft, extracts style learnings from your edits, and updates `memory/brand/writing_style.md` so future drafts need fewer changes.

## Process

1. Load originals from `outputs/content/article.md` and `outputs/content/linkedin-posts.md`
2. If a Medium URL is in $ARGUMENTS — fetch the published article
3. If LinkedIn post text is in $ARGUMENTS — use as the final post
4. If neither is in $ARGUMENTS — ask for at least one before continuing
5. Compare draft vs final across: title, hook, structure, length, voice, evidence, conclusion
6. For LinkedIn: note which variant was used and how the hook was edited
7. Extract style learnings as actionable rules
8. Append learnings to `memory/brand/writing_style.md` under `## Learned from Published Posts`
9. Log the full round to `memory/brand/feedback-log.md`

## Output

Confirm:

- Number of learnings extracted
- 3 most impactful rules added
- Paths updated
