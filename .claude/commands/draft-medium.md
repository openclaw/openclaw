Generate a full Medium article draft using the researcher → writer → editor pipeline.

$ARGUMENTS

Process:

1. If a topic is provided in $ARGUMENTS, run the researcher subagent to build a quick source pack first
2. If no topic provided, read `outputs/content/source-pack.md` for existing research
3. Use the writer subagent to draft the full article (800–1200 words)
4. Use the editor subagent to sharpen the draft
5. Read `memory/brand/writing_style.md` to ensure voice matches throughout

Quality gate before saving:

- [ ] Hook grabs attention in the first sentence
- [ ] Thesis is clear within the first 150 words
- [ ] At least 3 pieces of specific evidence
- [ ] Actionable takeaway in the conclusion
- [ ] No paragraphs over 3 sentences

Output format:

```
# [Article Title]

[Full article text — 800–1200 words]

---
**Sources**
- [References]

---
*Word count: [N]*
*Topic: [Topic]*
*Generated: [Date]*
```

Save to `outputs/content/article.md` (overwrite if exists).
Also archive a copy to `data/research/[date]-[slug].md`.

Confirm when saved and print the title + hook.
