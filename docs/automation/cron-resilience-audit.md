---
summary: "Local Gateway cron coverage & resilience audit (schedules, retries, alerting gaps)"
read_when:
  - Auditing Scheduled Tasks (Cron) coverage
  - Checking retry/backoff and failure notification wiring
  - Verifying that enabled/disabled cron jobs are intentional
title: "Cron coverage & resilience audit"
sidebarTitle: "Cron resilience audit"
---

# Cron coverage & resilience audit

Source of truth (Gateway runtime state): `~/.openclaw/cron/jobs.json`.
Reference for retry defaults / cron failure behavior: `/docs/automation/cron-jobs.md`.

Generated: **2026-05-11 2:30 PM America/Los_Angeles**.

## 1) Inventory: cron jobs in `jobs.json`

| Enabled | Job                                            | Agent   | Schedule (tz: America/Los_Angeles) | wakeMode | Delivery                                 | timeoutSeconds | toolsAllow                | deleteAfterRun |
| ------- | ---------------------------------------------- | ------- | ---------------------------------- | -------- | ---------------------------------------- | -------------- | ------------------------- | -------------- |
| ✅      | Auditor sweep                                  | auditor | `0 21 */2 * *` (cron)              | now      | announce → `channel:1494223201109282876` | —              | —                         | —              |
| ✅      | Build queue sweep                              | wrench  | `30 */2 * * *` (cron)              | now      | announce → `channel:1494223167550521344` | —              | `exec, read, write, edit` | false          |
| ✅      | Future task generator (wrench done -> backlog) | grind   | `0 */2 * * *` (cron)               | now      | announce → `channel:1497871709825536020` | —              | —                         | false          |
| ✅      | Morning briefing                               | grind   | `0 8 */2 * *` (cron)               | now      | announce → `channel:1497871668406911107` | —              | —                         | —              |
| ✅      | Outreach draft sweep                           | pitch   | `30 9-22/12 * * *` (cron)          | now      | announce → `channel:1497871953888018492` | —              | —                         | false          |
| ✅      | Research sweep                                 | nerd    | `0 9-21/12 * * *` (cron)           | now      | announce → `channel:1494223143999639572` | —              | —                         | false          |
| ✅      | Scout opportunity sweep                        | scout   | `0 10 */2 * *` (cron)              | now      | announce → `channel:1497872044010766453` | —              | —                         | —              |
| ✅      | Task pull loop (backlog -> triaged)            | grind   | `0 8-23/6 * * *` (cron)            | now      | announce → `channel:1497871709825536020` | —              | —                         | false          |
| ✅      | Task promotion pass (triaged -> assigned)      | grind   | `10 */2 * * *` (cron)              | now      | announce → `channel:1497871709825536020` | —              | —                         | false          |
| ✅      | supabase heartbeat pulse                       | —       | `every 7200000ms` (every)          | now      | **none**                                 | —              | `exec`                    | —              |
| ❌      | SMB Web Search Runner                          | main    | `0 9,15 * * *` (cron)              | now      | announce → `8492041088`                  | 900            | `exec`                    | —              |

## 2) Retry/backoff behavior (defaults)

From `/docs/automation/cron-jobs.md` configuration reference:

- `cron.retry.maxAttempts`: **3**
- `cron.retry.backoffMs`: **[60_000, 120_000, 300_000]**
- `cron.retry.retryOn`: `rate_limit`, `overloaded`, `network`, `server_error`

No per-job retry overrides are present in `jobs.json`, so the above applies globally.

## 3) Findings (coverage + resilience)

### Finding A (P5): Silent failure risk for `supabase heartbeat pulse`

- The job’s delivery mode is `none`.
- Per docs, failure notifications fall back to the primary announce target only when the job delivers via `announce`.
- With delivery mode `none`, heartbeat update failures can become effectively invisible unless `cron.failureDestination` (global) or `job.delivery.failureDestination` (per-job) is set.

**Impact:** Missing/late heartbeats can break downstream monitoring or create confusing “stale agent” symptoms.

### Finding B (P4): Disabled SMB runner needs explicit intent

- `SMB Web Search Runner` is currently `enabled: false`.

**Impact:** If this was accidental, opportunities/search freshness can stall without any reminder.

### Finding C (P4): High tool surface for `Build queue sweep`

- `Build queue sweep` permits `toolsAllow: ['exec','read','write','edit']`.

**Impact:** This widens blast radius if the prompt logic or task selection is ever wrong.

### Finding D (P3): No visible per-job alert routing documentation

Even though many jobs use `announce`, the doc doesn’t call out the “delivery none ⇒ failure routing must be explicit” rule as a checklist.

## 4) Recommendations (with priority)

1. **(P5) Configure failure notification routing for none-delivery jobs**
   - Option 1 (global): set `cron.failureDestination`.
   - Option 2 (per job): set `job.delivery.failureDestination` for `supabase heartbeat pulse`.
   - Goal: ensure provider/model/tool failures produce an observable alert.

2. **(P4) Add/confirm a re-enable + alert plan for the disabled SMB runner**
   - If disabled intentionally, document the reason and next review date.
   - If unintentional, re-enable and verify delivery target.

3. **(P4) Reduce toolsAllowed for build queue sweep (least privilege)**
   - Keep only the minimum required tools for selecting/patching tasks and running builds.

4. **(P3) Extend cron docs with an “alerting checklist”**
   - Add a short section: “delivery none/webhook/silent modes require explicit failureDestination routing.”

## 5) Appendix: how this audit was produced

- Parsed `~/.openclaw/cron/jobs.json` for each job’s:
  - `enabled`, `name`, `agentId`
  - schedule (`schedule.kind`, `schedule.expr`/`everyMs`, and `schedule.tz`)
  - runtime payload (`timeoutSeconds`, `toolsAllow`)
  - delivery mode and target (`delivery.mode`, `delivery.to`)
- Cross-referenced retry + failure notification behavior with the configuration reference in:
  - `docs/automation/cron-jobs.md`
