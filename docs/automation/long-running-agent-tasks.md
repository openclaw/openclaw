---
summary: "Patterns for progress reporting and background work in long-running agent tasks"
read_when:
  - Designing or debugging long-running agent tasks
  - Choosing how agents should report progress over minutes or hours
  - Wiring cron + background scripts + status files together
title: "Long-running Agent Tasks and Progress Reporting"
---

# Long-running Agent Tasks and Progress Reporting

> **Goal:** Make long-running tasks visible and controllable without spamming users or blocking the agent.

Large migrations, full-site audits, bulk media jobs, or cross-host maintenance can run for minutes or hours.
If the agent only reports at the very end, users see a "black box" with no progress, no ETA, and no early
signal when something is stuck.

This guide describes four practical patterns for progress reporting and task tracking in OpenClaw:

- direct background processes
- status files + cron checks
- multi-agent coordination over status files
- recurring cron jobs that act as sentinels

It also introduces a **task status file shape** that you can standardize on across your own automations.

## Problem: The long-task black hole

Traditional request/response flows are a poor fit for long-running work:

- the agent receives a command ("run a 30-minute migration"),
- starts executing,
- and the user sees nothing until success or failure.

That leads to:

- **anxiety**: users do not know whether the task is still running,
- **loss of control**: there is no obvious way to intervene or adjust,
- **wasted time**: if the task failed early, the user finds out only at the end.

The core challenge is: **how can a long-running task "look up" and report progress, without blocking or
restarting the work itself?**

## Pattern 1: Direct background process + polling

**Best fit:** one-off, short tasks (typically \< 10 minutes) where the agent stays online.

The simplest pattern:

1. the agent writes a small script and launches it in the background,
2. the script writes progress to a status file as it runs,
3. the agent polls that status file and reports updates to the user.

### Example: bulk image compression

You ask the agent:

> Compress all images under `static/images/` that are larger than 500KB down to ~500KB.

The agent might create a shell script:

```bash
#!/bin/bash
# compress-images.sh
# Compress large images and write progress to a status file.

IMAGES=$(find static/images/ -size +500k -name "*.png" -o -name "*.jpg")
TOTAL=$(echo "$IMAGES" | wc -l)
DONE=0

echo '{"status":"running","total":'$TOTAL',"done":0}' > /tmp/compress-status.json

for img in $IMAGES; do
  convert "$img" -quality 85 -resize '1920x1920>' "$img"
  DONE=$((DONE + 1))
  echo '{"status":"running","total":'$TOTAL',"done":'$DONE'}' > /tmp/compress-status.json
done

echo '{"status":"completed","total":'$TOTAL',"done":'$TOTAL'}' > /tmp/compress-status.json
```

The agent starts the script in the background, then periodically reads `/tmp/compress-status.json`
and posts updates like:

> Image compression in progress: 23/47 files completed (~48%).

### Characteristics

- **Implementation complexity:** low (simple script + polling).
- **Typical duration:** \< 10 minutes.
- **Progress granularity:** per-step, highly accurate.
- **Resilience:** limited — if the process dies, the agent must infer it from stale status.
- **Agent usage:** the agent must stay alive to poll and summarize.

This pattern is fine for small, self-contained jobs. For longer tasks, keeping the agent "waiting around"
is wasteful; consider the next patterns.

## Pattern 2: Status file + cron checks

**Best fit:** long-running, one-off tasks (10 minutes to several hours) that do **not** need human decisions.

Instead of having the agent sit and wait, let the task run independently and use cron jobs to **inspect**
its status file and notify when something changes.

### Example: full-site SEO audit

You ask the agent to run a full SEO audit over every blog post:

- title length,
- meta description,
- internal link density,
- image `alt` text,
- dead links.

The site has ~135 posts and each one requires fetching + analysis, so the whole audit may take 30–60 minutes.

The agent can:

1. write and start an audit script that updates a status file as it progresses,
2. configure a cron job that wakes up every few minutes to read the status file and report progress.

The script might emit a JSON status file like:

```json5
{
  "task": "seo-audit",
  "status": "running",
  "current": 67,
  "total": 135,
  "message": "Analyzing 108-compression-is-intelligence.md",
  "updated_at": "2026-03-10T14:32:00+08:00",
  "results_file": "/home/user/.openclaw/workspace/tasks/seo-audit-results.json"
}
```

The cron job uses the Gateway scheduler (see [/automation/cron-jobs](/automation/cron-jobs)) and runs with
`sessionTarget: "main"` or `sessionTarget: "isolated"` depending on how you want updates delivered.

### Characteristics

- **Implementation complexity:** medium (script + status file + cron config).
- **Typical duration:** 10 minutes to several hours.
- **Progress granularity:** depends on cron frequency (for example every 5–10 minutes).
- **Resilience:** good — stale `updated_at` timestamps can flag stuck tasks.
- **Agent usage:** low — the agent only wakes on cron runs.

This pattern cleanly decouples **"do the work"** (script) from **"tell the user what is happening"** (cron).

## Pattern 3: Multi-agent coordination + status file

**Best fit:** long-running tasks with **human decision points**.

Some workflows are not "fire and forget". They need approvals, choices, or manual recovery in the middle:

- database migrations with ambiguous conflicts,
- server moves where cutover timing matters,
- infrastructure changes that may need a pause + human review.

In these cases, split responsibilities:

- a "worker" agent (or script) executes the steps and appends to a status file,
- a "front" agent monitors the status file, talks to the user, and writes decisions back.

### Example: server migration

You want to migrate services off an old VPS onto a new host. The plan covers:

1. database backup and restore,
2. config and secrets migration,
3. DNS cutover,
4. service health checks on the new host.

Along the way, the worker may need decisions:

- keep or drop existing tables,
- override or merge configs,
- proceed with DNS cutover now or later.

The status file can encode these pauses:

```json5
{
  "task": "server-migration",
  "status": "waiting_for_input",
  "phase": "database-restore",
  "completed_phases": ["backup", "config-sync"],
  "current_issue": {
    "type": "decision_required",
    "message": "Target database has existing table user_sessions (2,847 rows).",
    "options": [
      "drop: delete and restore from backup",
      "merge: attempt to merge data (may hit conflicts)",
      "rename: rename existing table to user_sessions_bak and restore"
    ]
  },
  "updated_at": "2026-03-10T14:32:00+08:00"
}
```

The front agent:

- polls this status (via a cron job or heartbeat),
- surfaces the question to the user,
- writes the chosen option back into a "decision" field that the worker reads.

### Characteristics

- **Implementation complexity:** higher (two agents or roles + richer status protocol).
- **Typical duration:** tens of minutes to hours.
- **Human-in-the-loop:** first-class — design assumes manual checkpoints.
- **Resilience:** strong — the status file is a durable "timeline" that enables restarts.
- **Agent usage:** divided — one side runs tasks, the other handles interaction.

This pattern maps well to "ops runbooks" where a junior operator (worker) executes steps and a senior
operator (user via front agent) approves key transitions.

## Pattern 4: Cron + status file as a sentinel

**Best fit:** recurring checks where "no news is good news".

Some tasks are small and quick, but must run **regularly**:

- SSL certificate expiry checks across many domains,
- disk usage and log file growth monitoring,
- periodic quota checks for external APIs.

Here, cron + status files can act as a **sentinel**:

- a small script runs on schedule and writes a status file,
- the cron job reads it and only alerts when something drifts into a warning or critical state.

### Example: multi-domain SSL expiry monitoring

A shell script runs daily, checks certificate expiration dates for a domain list, and writes:

```json5
{
  "task": "ssl-cert-check",
  "status": "completed",
  "checked_at": "2026-03-10T09:00:01Z",
  "certificates": [
    { "domain": "api.example.com", "expiry": "2026-03-22", "days_left": 12 },
    { "domain": "blog.example.com", "expiry": "2026-10-15", "days_left": 247 }
  ]
}
```

The cron job:

- runs the script,
- reads this file,
- sends nothing when all `days_left` values are healthy,
- sends a **warning** or **urgent** message when any domain is close to expiry.

### Characteristics

- **Implementation complexity:** low (script + cron entry).
- **Execution frequency:** minutes to days.
- **Progress concept:** not a "progress bar" but a state snapshot per run.
- **Resilience:** good — each run is independent; earlier failures do not block later runs.
- **Agent usage:** minimal — the agent only wakes to format and send alerts when needed.

This is ideal for "watchdog" style automations.

## Choosing between the four patterns

You can think of the decision as:

1. **Does the task repeat on a schedule?**
   - **Yes** → start with **Pattern 4** (cron sentinel).
   - **No** → continue.
2. **How long will it run?**
   - **\< 10 minutes** → **Pattern 1** (background process + polling) is often enough.
   - **\> 10 minutes** → continue.
3. **Does it need human decisions mid-flight?**
   - **Yes** → **Pattern 3** (multi-agent + status file).
   - **No** → **Pattern 2** (status file + cron checks).

In practice you will often combine them. For example:

- Pattern 2 for the main flow of a migration,
- Pattern 3 at specific points that require approval,
- Pattern 4 to keep monitoring systems healthy afterward.

## Standardizing the task status file shape

All four patterns rely on some form of **status file** as the communication channel between:

- worker processes,
- the Gateway / agents,
- and sometimes external tooling.

To make this robust and composable, you can adopt a **standard JSON shape** for task status files.

OpenClaw ships a small helper in `src/infra/task-status.ts` that defines a conservative schema:

```ts
export type OpenClawTaskStatusV1 = {
  $schema?: "openclaw-task-status-v1";
  taskId: string;
  taskType?: "one-shot" | "recurring";
  status: "pending" | "running" | "waiting_for_input" | "completed" | "failed";
  progress?: {
    current?: number;
    total?: number;
    percentage?: number;
    etaSeconds?: number;
  };
  message?: string;
  errorCode?: string;
  errorDetails?: unknown;
  requiresInput?: {
    message: string;
    options?: Array<{ id: string; label: string } & Record<string, unknown>>;
  } | null;
  history?: Array<{ at: string; event: string } & Record<string, unknown>>;
  updatedAt: string;
  extensions?: Record<string, unknown>;
};
```

Workers write status files that roughly match this shape; agents and tools can then call
`readTaskStatusFile(path)` to get a validated structure:

```ts
import { readTaskStatusFile } from "../infra/task-status.js";

const result = await readTaskStatusFile(
  "/home/user/.openclaw/workspace/tasks/seo-audit-status.json",
);
if (!result.ok) {
  // status file missing, invalid, or stale
  return;
}

const { status } = result;
// status.status, status.progress, status.requiresInput, etc.
```

This does **not** enforce a global contract for all tasks, but provides a solid common ground for:

- cron jobs that summarize progress,
- heartbeat runs that list active long tasks,
- future dashboards that visualize task state across agents.

## Summary

- Long-running work needs **structured progress reporting**, not just a final result.
- OpenClaw supports several patterns that combine:
  - background scripts or processes,
  - cron jobs and heartbeats,
  - status files,
  - and multi-agent coordination.
- You should:
  - use **Pattern 1** for small one-off chores,
  - use **Pattern 2** for long but autonomous tasks,
  - use **Pattern 3** when human approvals are required,
  - use **Pattern 4** for recurring "sentinel" checks.
- Standardizing your status file shape around `OpenClawTaskStatusV1` makes it easier to evolve
  from ad-hoc scripts to shared tools and dashboards over time.

