---
name: retro
description: |
  Weekly retrospective with developer stats, shipping streaks, test health
  trends, and growth opportunities. Use for weekly check-ins or when asked
  for a retrospective.
---

# Retro — Weekly Retrospective

Structured weekly retrospective that combines quantitative data with qualitative reflection.

**Related skills:** [ship](../ship/SKILL.md) | [review](../review/SKILL.md) | [document-release](../document-release/SKILL.md)

---

## Data Collection

### Git Stats (last 7 days)

```bash
git log --since="7 days ago" --oneline | wc -l          # commits
git log --since="7 days ago" --shortstat --format="" | \
  awk '/files? changed/ {f+=$1; i+=$4; d+=$6} END {print f, i, d}'  # files, insertions, deletions
git log --since="7 days ago" --format="%an" | sort | uniq -c | sort -rn  # per-person
```

### PR Stats

```bash
gh pr list --state merged --search "merged:>$(date -v-7d +%Y-%m-%d)" --json number,title,additions,deletions
```

### Test Health

```bash
# Run test suite and capture results
npm test 2>&1 | tail -5   # or equivalent for the project
```

---

## Retrospective Format

```
WEEKLY RETRO: [Date Range]
═══════════════════════════════════════

📊 STATS
  Commits:          N
  Lines added:      N
  Lines removed:    N
  Net LOC:          N
  PRs merged:       N
  Tests:            N pass / N fail

🏃 VELOCITY
  Shipping streak:  N days (commits on consecutive days)
  Biggest PR:       #N — [title] (+X/-Y)
  Most active area: [directory/module]

✅ WINS
  - [What went well this week]
  - [Features shipped, bugs fixed, improvements made]

⚠️ CONCERNS
  - [What didn't go well]
  - [Technical debt accumulated]
  - [Tests skipped or coverage gaps]

📋 NEXT WEEK
  - [Priorities for next week]
  - [Deferred items from TODOS.md]
  - [Tech debt to address]

═══════════════════════════════════════
```

---

## Growth Opportunities

Flag patterns that suggest improvement areas:

- **Low test coverage in active files** — Files changed frequently but with few tests
- **Large PRs** — PRs with >500 lines suggest insufficient decomposition
- **Long-lived branches** — Branches open >5 days suggest integration risk
- **Recurring bug areas** — Same files in bug-fix commits suggest architectural issues
