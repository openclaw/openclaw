---
name: mai-contribution-tracker
description: >-
  Track MAI Universe contribution and monetization events, auto-update Obsidian dashboard.
  Records open-source PRs, skill publishes, app revenue, community contributions with a point system.
  Triggers: "기여 기록해줘", "수익 등록해줘", "대시보드 업데이트", "contribution log",
  "PR merged", "revenue update", "기여 추적", "contribution tracker", "점수 확인",
  "기여 현황", "수익 현황", "OSS 기여".
  NOT for: simple project status queries (use memory_search), GitHub PR operations (use github skill).
---

# MAI Contribution Tracker

Philosophy: **기여할수록 강해지고, 수익화할수록 지속된다** — tracked with data.

## Data Files

| File                                        | Role                   |
| ------------------------------------------- | ---------------------- |
| `memory/contributions.md`                   | Contribution event log |
| `memory/revenue-tracker.md`                 | Monetization event log |
| `scripts/update-contribution-dashboard.ps1` | Dashboard sync script  |

## Dashboard (Obsidian)

| File                                                        | Content                        |
| ----------------------------------------------------------- | ------------------------------ |
| `JINI_SYNC\01.PROJECT\00.MAIBOT\_CONTRIBUTION_DASHBOARD.md` | Full detailed dashboard        |
| `JINI_SYNC\TEMPLATES\Dashboard.md`                          | Main dashboard AUTO block sync |

## Workflow

### A. Contribution Event

1. Classify event using score table (see [references/data-schema.md](references/data-schema.md))
2. Append row to `memory/contributions.md`:
   ```
   | YYYY-MM-DD | repo/project | type_code | description | URL | score |
   ```
3. Run dashboard script:
   ```powershell
   powershell -File C:\MAIBOT\scripts\update-contribution-dashboard.ps1
   ```
4. Report to Discord DM

### B. Revenue Event

1. Update `memory/revenue-tracker.md` monthly table (project + month row)
2. Run dashboard script (same as above)
3. Report to Discord DM

### C. Auto PR Merge Detection

Script auto-queries GitHub API for PR status changes (OPEN→MERGED) and updates scores.
Runs automatically via heartbeat (daily 06:05). No manual trigger needed.

## Score Table (Quick Reference)

| Type Code               | Score | Example                       |
| ----------------------- | ----- | ----------------------------- |
| `OSS_PR_MERGED`         | 10    | openclaw PR merged            |
| `OSS_PR_OPEN`           | 3     | PR submitted (pending)        |
| `OSS_ISSUE_FIXED`       | 5     | Issue fix commit              |
| `SKILL_PUBLISHED`       | 5     | ClawHub skill deploy          |
| `BLOG_POST`             | 3     | Tech blog post                |
| `COMMUNITY_HELP`        | 2     | Discord/GitHub community help |
| `DOCS_CONTRIBUTION`     | 2     | Documentation PR              |
| `GITHUB_STAR_MILESTONE` | 1     | Project stars per 10          |

Full schema details: [references/data-schema.md](references/data-schema.md)
