---
name: openclaw-cron-hygiene
description: Audit and tidy OpenClaw cron schedules for duplicate jobs, conflicting times, and unclear naming. Use when users ask to review existing automations, reduce noisy schedules, or standardize cron job setup.
---

# OpenClaw Cron Hygiene

Review scheduler health and recommend cleanups.

## Baseline commands

Run:

```bash
openclaw cron list
```

For specific jobs:

```bash
openclaw cron runs <job-id>
```

## Hygiene checklist

1. Detect duplicate jobs with same purpose.
2. Detect conflicting/overlapping run times.
3. Flag disabled jobs that should be removed.
4. Check naming consistency and clarity.
5. Check delivery mode consistency (announce/webhook/none).

## Recommendations

Provide:

- keep/merge/remove suggestion per duplicate group
- proposed naming convention
- cadence tuning suggestions (reduce noise)
- retention or summary guidance when jobs are chatty

## Safe execution rule

Do not edit/remove jobs without explicit approval.

When approved, apply minimal change commands and confirm result with `openclaw cron list`.
