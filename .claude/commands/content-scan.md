Scan for the top frontier AI developments with strong enterprise thought leadership potential.

Read `memory/brand/editorial_brain.md` for the enterprise editorial lens before scanning.
Read `memory/brand/writing_style.md` for audience and voice context.

Use the researcher subagent to:

1. Collect recent AI developments from the past 7 days
2. Cluster duplicates referring to the same underlying development
3. Evaluate each development using the scoring rubric below
4. Return only stories scoring above 75

---

## Scoring Rubric (100 points total)

| Dimension                                        | Points |
| ------------------------------------------------ | ------ |
| Novelty                                          | 15     |
| Strategic Importance                             | 15     |
| Enterprise Relevance                             | 20     |
| Practical Applicability                          | 15     |
| Thought Leadership Potential                     | 10     |
| Audience Fit (CIOs, CTOs, enterprise architects) | 10     |
| Evidence Quality                                 | 10     |
| Cross-Platform Reuse Potential                   | 5      |

---

## Detection Targets

Prioritize signals that reveal meaningful shifts in:

- AI capabilities (agents, reasoning, multimodal)
- Enterprise adoption patterns
- AI infrastructure and platform architecture
- Agent systems and orchestration
- Enterprise productivity and workflow transformation
- AI governance and regulation
- Data platform readiness

Prefer primary sources: AI lab announcements, research papers, arXiv, GitHub trending, enterprise deployment stories.

---

## Output Structure

For each story above 75, return:

```
---
story_id: [slug]
headline: [clear descriptive headline]
source_links: [URLs]
published_date: [date]
category: [AI Capabilities / Enterprise Adoption / Infrastructure / Governance / Productivity]
sub_category: [specific tag]

summary_1line: [one sentence]
summary_5line: [five sentences — what happened, why it matters, enterprise angle, market gap, implication]

novelty_score: [0–15]
enterprise_relevance_score: [0–20]
thought_leadership_score: [0–10]
total_score: [0–100]

why_it_matters_for_leaders: [2–3 sentences]
why_it_matters_for_tech_teams: [2–3 sentences]

editorial_angles:
  angle_1_strategy: [strategic leadership insight]
  angle_2_operating_model: [enterprise operating model implication]
  angle_3_platform: [technical or platform capability shift]

possible_contrarian_angles: [1–2 non-obvious takes]

recommended_formats:
  - x_post
  - linkedin_post
  - medium_article

risk_flags: [hype / unsupported claims / single source / etc.]
duplicate_of: [story_id if applicable]
---
```

---

## Filter Rules

Only return stories scoring above 75.
Prioritize developments that reveal deeper shifts in enterprise AI adoption.
Reject low-signal stories per the editorial brain rejection rules.

---

## Save Output

Save the full structured output to:

1. `outputs/content/scan-results.md` — overwrite with latest (used by orchestrator)
2. `outputs/content/ideas/[YYYY-MM-DD-HH-MM]-scan.md` — dated archive copy (never overwrite)

Confirm both save paths and print the top-scoring story with its recommended formats.
