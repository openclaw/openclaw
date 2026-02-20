# Mission Control v1 Proposal

Related issue: https://github.com/openclaw/openclaw/issues/21600
Prototype repository: https://github.com/frank8ai/openclaw-mission-control

## Problem

Operators need a fast operational view of what OpenClaw is currently doing across cron jobs, sessions, and subagents. Existing workflows require jumping across multiple commands/logs.

## v1 Scope (read-only, merge-friendly)

- Runtime overview for tasks + cron + sessions + subagents
- Runs history and failed-run aggregation
- Filter/search/time-range controls
- Explicit fallback/source signaling for observability

## Non-goals for v1

- No direct runtime control actions in v1
- No kill/run-now/enable-disable actions in v1 UI

## v2 Follow-up (separate track)

- run-now / enable-disable / kill actions
- with permissions, second confirmation, audit trail, secure-default-off

## Why this shape

- Low risk to core runtime
- Useful immediately for operators
- Enables incremental PR split (API -> data aggregation -> UI)

## Suggested PR split

1. Runtime aggregation API (read-only)
2. History/failure rollups + filtering params
3. UI pages/components wired to those APIs
4. Optional docs/examples
