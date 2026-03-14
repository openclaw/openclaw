Run the full Enterprise AI Content Engine pipeline from signal discovery to platform-ready content.

$ARGUMENTS

Read `memory/brand/editorial_brain.md` for the enterprise editorial lens before doing anything.
Read `memory/brand/writing_style.md` for voice and audience context.

---

## Pipeline Steps

### Step 1 — Signal Discovery

If $ARGUMENTS contains a specific topic or story, use that as the input signal.

Otherwise, read `outputs/content/scan-results.md` for existing scan results.
If the file is empty or older than 24 hours, run `/content-scan` first.

### Step 2 — Filter and Score

From the scan results, identify stories with total_score > 75.
Reject stories that match the editorial brain rejection rules (hype, vendor marketing, minor updates, repeated commentary).

### Step 3 — Select Lead Story

Choose the highest-scoring story that:

- Has not been covered in the last 7 days (check `outputs/content/ideas/` for recent articles)
- Has a genuine enterprise leadership angle
- Offers a non-obvious interpretation

If a specific story from $ARGUMENTS was provided, use that directly.

### Step 4 — Select Best Angle

For the chosen story, identify the strongest angle from:

- enterprise transformation
- organizational change
- AI adoption barriers
- data platform readiness
- enterprise productivity
- governance and risk

### Step 5 — Route to Format

Apply routing logic:

| Condition                             | Format         |
| ------------------------------------- | -------------- |
| Novel but requires short explanation  | X post         |
| Reveals leadership insight            | LinkedIn post  |
| Exposes deeper strategic implications | Medium article |
| Exceptional importance (score > 90)   | All platforms  |

### Step 6 — Generate Content

Based on routing:

- **X only**: Draft a sharp 280-character post with the core insight and enterprise angle
- **LinkedIn only**: Run `/repurpose-linkedin` (use the scan result as source, no article required)
- **Medium**: Run `/draft-medium` with the chosen story and angle, then run `/repurpose-linkedin`
- **All platforms**: Run `/draft-medium` first, then `/repurpose-linkedin`, then draft X post

---

## Duplication Control

Before generating, check `outputs/content/ideas/` for recent dated archives.
If the same underlying topic was covered within 7 days, skip unless a meaningful new development exists.
Note the reason in the output log.

---

## Output Log

At the end, print a summary:

```
# Content Pipeline Run — [Date]

## Story Selected
story_id: [id]
headline: [headline]
total_score: [score]
chosen_angle: [angle]
reason: [why this story was selected]
duplicate_check: [clear / skipped — reason]

## Content Generated
platform: [X / LinkedIn / Medium / All]
files_saved:
  - [path]
  - [path]

## Next Run Recommendation
[What to cover next or what angle was not yet used]
```

Save this log to `outputs/content/pipeline-log.md` (append with date header, do not overwrite).
