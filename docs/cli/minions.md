---
title: openclaw minions
description: Inspect and manage the minions job queue
---

# openclaw minions

Inspect and manage the durable job queue that powers subagents, ACP sessions,
CLI runs, and cron ticks.

## Commands

### list

Show recent jobs with optional filters.

```bash
openclaw minions list
openclaw minions list --status active
openclaw minions list --name subagent.spawn --limit 50
```

Options:
- `--status <status>` — Filter: waiting, active, completed, failed, dead, cancelled
- `--queue <queue>` — Filter by queue name (default: "default")
- `--name <name>` — Filter by job name
- `--limit <n>` — Max results (default: 20)

### get

Show full details for a specific job.

```bash
openclaw minions get 42
```

### cancel

Cancel a job and cascade-cancel all its descendants.

```bash
openclaw minions cancel 42
```

### stats

Show queue health dashboard with status counts and stalled job detection.

```bash
openclaw minions stats
```

### retry

Re-queue a failed or dead job for another attempt.

```bash
openclaw minions retry 42
```

### prune

Remove old completed/dead/cancelled jobs.

```bash
openclaw minions prune
openclaw minions prune --days 7
```

### smoke

Quick end-to-end smoke test: submits a job, claims it, completes it, and
reports the round-trip time.

```bash
openclaw minions smoke
```
