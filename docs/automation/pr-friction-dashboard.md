---
summary: "Build a daily PR dashboard plus weekly merge-friction digest from GitHub + JSONL records"
read_when:
  - You want a lightweight PR health dashboard during the week
  - You track merge-friction metrics and need weekly summaries
  - You want Slack-ready human-readable updates instead of raw JSON
title: "PR Friction Dashboard"
---

# PR Friction Dashboard

This workflow gives you two views:

1. **In-week dashboard (daily)** for open PR queue health.
2. **Weekly digest** for merged PR friction trends.

It is designed for teams that already store merged PR friction records in JSONL (for example from webhook ingest).

## What this dashboard tracks

### Open PR queue (live)

- Open PR count
- Age buckets (`<24h`, `1-3d`, `3-7d`, `>7d`)
- Stale open PR count (`updated_at > 7 days`)
- Oldest open PRs for triage

### Merged PR friction (windowed)

- Merged PR count
- High-friction merge count
- p50 / p90 of:
  - lead time (hours)
  - review cycles
  - failed CI runs before merge
  - friction score
- Top repos by merged PR volume
- Highest-friction merged PRs

## Lead time definition

In this setup, **lead time** means:

- `ready_for_review_at -> merged_at` (in hours)
- fallback: `created_at -> merged_at` when no draft/ready event exists

This measures review + CI + merge cycle time after PR creation/readiness. It does **not** measure coding time before PR open.

## Scripts

- `scripts/pr-friction-dashboard.ts`
  - Builds dashboard markdown and optional JSON snapshot.
- `scripts/pr-friction-summary.ts`
  - Converts dashboard JSON into a human-readable summary for Slack or chat.

## Generate a dashboard

```bash
bun scripts/pr-friction-dashboard.ts \
  --owner Dodhon \
  --input /Users/<you>/clawd/reports/pr-friction.jsonl \
  --output /Users/<you>/clawd/reports/pr-friction-dashboard.md \
  --json-output /Users/<you>/clawd/reports/pr-friction-dashboard.json
```

Single repo scope:

```bash
bun scripts/pr-friction-dashboard.ts \
  --owner Dodhon \
  --repo Dodhon/Earth \
  --window-days 7
```

## Render a human-readable summary

```bash
bun scripts/pr-friction-summary.ts \
  --input /Users/<you>/clawd/reports/pr-friction-dashboard.json
```

The summary is intentionally narrative + bullet-based so it is readable in Slack by default.

## Cron pattern (daily + weekly)

Recommended schedule:

- **Daily dashboard** (Mon-Fri morning): open queue + current friction snapshot
- **Weekly digest** (Monday): weekly trend summary + top actions

Use isolated cron jobs for both, then send human-readable text to your target channel.

## Notes

- If GitHub API access fails, dashboard generation still works for the local JSONL metrics section.
- For large orgs, start with one owner or repo filter and widen scope after baseline stability.
