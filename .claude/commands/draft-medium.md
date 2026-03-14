Generate a full Medium article draft using the researcher → writer → editor pipeline.

$ARGUMENTS

Read `memory/brand/editorial_brain.md` for the enterprise editorial lens.
Read `memory/brand/writing_style.md` to ensure voice matches throughout.

---

## Process

1. If a topic is provided in $ARGUMENTS, run the researcher subagent to build a source pack first
2. If no topic provided, read `outputs/content/scan-results.md` for existing scan results, or fall back to `outputs/content/source-pack.md`
3. Use the writer subagent to draft the full article (1000–1300 words)
4. Use the editor subagent to sharpen the draft

---

## Article Structure (9 sections)

Every article must follow this structure:

1. **Opening claim** — Bold, specific, enterprise-relevant. The thesis in 1–2 sentences.
2. **What triggered this article** — The development, announcement, or shift that prompted writing now.
3. **What the market is seeing** — The mainstream interpretation and prevailing narrative.
4. **What the market is missing** — The deeper signal, contrarian angle, or overlooked implication.
5. **Enterprise implications** — Concrete impact on enterprise organizations, technology strategy, or investment priorities.
6. **Organizational implications** — How this affects teams, roles, workflows, or capability building.
7. **Operating model shifts required** — What leaders need to change about how their organization runs.
8. **Leadership actions** — 3–5 specific things a CIO, CTO, or enterprise leader should do or reconsider.
9. **Conclusion** — Forward-looking or provocative closing thought. No summary rehash.

---

## Writing Rules

- Avoid repeating obvious industry commentary
- Focus on insight derived from enterprise operating experience
- Tie every development back to leadership decisions
- Every claim needs supporting evidence or reasoning
- No paragraphs over 3 sentences
- Active voice throughout
- Concrete numbers over vague claims

---

## Quality Gate Before Saving

- [ ] Opening claim grabs attention and states the thesis clearly
- [ ] Thesis restated or reinforced within the first 150 words
- [ ] At least 3 pieces of specific evidence or concrete examples
- [ ] "What the market is missing" section has a genuine non-obvious angle
- [ ] Leadership actions are specific and actionable (not generic advice)
- [ ] Conclusion lands with impact — forward-looking or provocative
- [ ] No buzzwords: "leveraging", "synergies", "ecosystem", "game-changing"
- [ ] Word count: 1000–1300 words

---

## Output Format

```
# [Article Title]
## [Subheadline — one sentence that deepens the headline]

[Full article — 1000–1300 words across 9 sections]

---
**Sources**
- [References]

---
*Word count: [N]*
*Topic: [Topic]*
*Generated: [Date]*
```

Save to `outputs/content/article.md` (overwrite if exists).
Also archive to `outputs/content/ideas/[YYYY-MM-DD]-[slug].md`.

Confirm when saved and print the title, subheadline, and opening claim.
