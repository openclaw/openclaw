# AI Employees with Scheduled Tasks

**Date:** 2026-02-16
**Status:** Approved

## Problem

Employees exist as metadata but have no automated behavior. Cron jobs exist in the gateway but aren't tied to employees. There's no concept of "this employee runs this task every Monday at 9 AM."

## Solution

Employee-owned schedules stored in the dashboard DB. A lightweight scheduler dispatches tasks via the existing task/dispatch pipeline. Semi-autonomous: draft-access tasks go to review, execute-access tasks run automatically.

## Data Model

### New Table: `employee_schedules`

```sql
CREATE TABLE employee_schedules (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  agent_id TEXT NOT NULL DEFAULT 'main',
  priority TEXT NOT NULL DEFAULT 'medium',
  category TEXT NOT NULL DEFAULT 'operations',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
```

## Seed Employees

| Employee | Department | Schedules |
|----------|-----------|-----------|
| Social Media Manager | marketing | Daily engagement, weekly content calendar, monthly analytics |
| Financial Analyst | finance | Daily expense reconciliation, weekly P&L, monthly ZATCA compliance |
| Sales Development Rep | sales | Daily lead follow-ups, weekly pipeline review, monthly outreach |
| Operations Coordinator | operations | Daily health check, weekly standup summary, monthly KPIs |

## Scheduler Engine

- Runs every 60s via setInterval on the server
- Checks `next_run_at <= now` for enabled schedules
- Creates task + dispatches via existing pipeline
- Updates `last_run_at`, computes new `next_run_at`
- Idempotency via `last_run_at` guard

## API Endpoints

- `GET /api/employees/schedules` — List schedules for employee
- `POST /api/employees/schedules` — Create schedule
- `PATCH /api/employees/schedules` — Update schedule
- `DELETE /api/employees/schedules` — Delete schedule
- `POST /api/employees/schedules/run` — Manual trigger

## UI

Schedules section added to employees-view. Shows active schedules, next run, enable/disable toggle, "Run Now" button, create form with cron presets.
