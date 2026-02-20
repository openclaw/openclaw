# Long-Running Agents Guide

This guide explains how to run agents over **days** with **remote management** and **multi-session continuity**, using patterns from industry best practices (e.g. [Anthropic's long-running agent harness](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)).

## The problem

Agents run in discrete sessions. Each new session has **no memory** of the previous one. To make progress over many hours or days you need:

1. **Explicit state** the next run can read (progress file, feature list, DB progress).
2. **One clear step per run** so the agent doesn’t try to “do everything” or declare victory too early.
3. **Clean handoff** (e.g. git commit + progress update) so the next session starts from a known good state.

## How we support it

### 1. Progress and checkpointing (API)

- **`GET /api/agents/{agent_slug}/progress`** — Returns the latest progress for an agent (`state`, `summary`, `feature_list`, `updated_at`).
- **`PUT /api/agents/{agent_slug}/progress`** — Update progress after a run. Body can include:
  - `workflow_or_run_id` — Optional run or workflow id.
  - `state` — JSON object (merged with existing).
  - `summary` — Text summary for the next session.
  - `feature_list` — Optional list of `{id, description, passes}` for goal tracking.

The backend stores this in the `agent_progress` table so every run can “get up to speed” by reading progress first.

### 2. Recommended workflow

**First run (initializer):**

- Create or load a **feature list** (what “done” looks like).
- Optionally write an **init script** (e.g. how to run the app or tests).
- Call **`PUT .../progress`** with `feature_list` and initial `state`.

**Every run (coding/execution agent):**

1. **Read** `GET .../progress` and (if applicable) git log / workspace files.
2. **Pick one** feature or one incremental step.
3. **Execute** that step only.
4. **Commit** (e.g. git commit with a clear message).
5. **Update** `PUT .../progress` with new `state`, `summary`, and optionally updated `feature_list` (e.g. set `passes: true` for completed items).

This keeps each run bounded and leaves a clean state for the next run.

### 3. Remote management

- Run the **backend** on a server (e.g. Linux). Use **Tailscale Serve/Funnel** or **SSH tunnels** to reach the dashboard (see OpenClaw main docs).
- The **dashboard** (React app) shows agents, tasks, activity, and (via observability) health and errors. You can trigger runs, enable/disable agents, and set schedules from one place.
- **Observability:** Use `GET /api/observability/summary` and `GET /api/metrics` for a high-level view and simple metrics (run counts, pending/running tasks, failures).

### 4. Scheduling

- Set **cron schedules** per agent in the dashboard (e.g. every 6 hours for Finance, every hour for Operations).
- Each scheduled run should follow the “one step per run” pattern and update progress so the next run continues correctly.

### 5. Best practices

- **One feature or one step per run** — Avoid “one-shotting” the whole goal.
- **Always update progress** after each run so the next session knows where things stand.
- **Use the feature list** to avoid marking the whole job done too early; only set `passes: true` after real verification.
- **Test before claiming done** — Run the app or tests (e.g. via init script) and only then update progress/feature list.

## References

- [Anthropic: Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [OpenClaw Gateway remote access](https://docs.openclaw.ai/gateway/remote)
- Root **AUDIT.md** in this repo for the full audit and roadmap.
