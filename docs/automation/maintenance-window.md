---
summary: "Daily maintenance window: cron and heartbeat role isolation with deferred replay"
read_when:
  - Configuring scheduled downtime for cron and heartbeat runs
  - Diagnosing why a scheduled job did not fire at the expected time
  - Reviewing role isolation semantics for agent maintenance windows
title: "Maintenance window"
sidebarTitle: "Maintenance window"
---

# Maintenance window

A **maintenance window** is a daily, timezone-aware interval during which
ordinary cron and heartbeat execution is paused for any agent not explicitly
listed in `maintenanceAgents`. It is designed for environments where one
agent (typically `ops` or a similar privileged identity) needs to keep
running for backup, monitoring, or other keep-alive tasks while every other
agent's scheduled work is held.

This page is the operator-facing reference. The implementation lives in
`src/cron/maintenance-policy.ts` and the deferred-replay queue in
`src/cron/maintenance-deferred.ts`.

## When the window is active

Configure the block under `cron.maintenance` in your `openclaw.json`:

```json
{
  "cron": {
    "maintenance": {
      "enabled": true,
      "window": {
        "start": "02:00",
        "end": "04:00",
        "timezone": "UTC"
      },
      "maintenanceAgents": ["ops"],
      "allowManualRun": false
    }
  }
}
```

The fields:

- `enabled` (default `false`): master switch. When `false` the rest of the
  block is ignored.
- `window.start`, `window.end`: `HH:MM` (24h) values. v2 only supports
  single-day windows where `start < end`. Cross-midnight windows (e.g.
  `22:00` to `06:00`) are rejected by the schema; use two separate
  configuration changes if you need a multi-block schedule.
- `window.timezone`: IANA timezone, or one of the magic strings `user` /
  `local`. When omitted, falls back to `agents.defaults.userTimezone`.
- `maintenanceAgents`: agent ids that **continue** running during the
  window. Omit or set to `[]` to defer every agent (the v2 default; this
  is the strictest setting).
- `allowManualRun` (default `false`): whether `openclaw cron run <jobId>` and
  `openclaw automations run` may bypass the gate. Set to `true` only if you
  have a documented operational need (e.g. an on-call engineer needs to
  force-fire a job during a maintenance window).

## What the gate blocks

While the local wall clock is inside `[start, end)` (end-exclusive), the
following paths are deferred for any agent **not** in `maintenanceAgents`:

| Path                                          | Behaviour                                                  |
| --------------------------------------------- | ---------------------------------------------------------- |
| `openclaw cron run <jobId>` (`mode: "due"`)   | Returns `maintenance-blocked`                              |
| `openclaw automations run`                    | Returns `maintenance-blocked`                              |
| Scheduled cron jobs                           | Marked as deferred, replayed on phase exit                 |
| Heartbeat wakes                               | Defer with `reason: "maintenance-window"` until window end |
| `openclaw cron run <jobId>` (`mode: "force"`) | **Always admitted**                                        |

`mode: "force"` is the operator-initiated bypass and pierces the gate
unconditionally, even when `allowManualRun: false`. This mirrors the
existing cron "force" semantics: it is documented for emergency operator
use and produces the same `runnable: true` outcome as in the v1 design.

## What it does not block

- Channel-driven heartbeats (already gated by `heartbeat-active-hours`)
- `maintenanceAgents`-listed agents (their heartbeat ticks continue)
- Manual runs when `allowManualRun: true` (opt-in operator override)
- Manual runs in `force` mode (always admitted)

## Deferred replay

When the window ends, the gateway drains the deferred queue in FIFO order
and re-evaluates each job through the normal cron admission path. No
concurrent replay — the next scheduled tick is the source of truth for
"when should this run again". The replay is best-effort: if a job's
schedule fingerprint has changed since the deferral, the new schedule wins.

Replay state is process-local. Cross-process replays (e.g. the gateway
restarts mid-window) drop the in-memory backlog; jobs whose persistent
schedule was advanced during the window are picked up on the next tick.

## Observability

The maintenance block is surfaced in `cron.status` JSON:

```json
{
  "maintenance": {
    "enabled": true,
    "phase": "maintenance",
    "nextPhaseChangeMs": 1777090800000,
    "window": { "start": "02:00", "end": "04:00", "timezone": "UTC" },
    "maintenanceAgents": ["ops"],
    "allowManualRun": false,
    "deferredCount": 2,
    "deferredBacklog": [
      {
        "jobId": "weekly-report",
        "agentId": "main",
        "firstDeferredAtMs": 1777087200000,
        "lastDeferredAtMs": 1777087200000,
        "phaseId": "phase-1-1777087200000"
      }
    ]
  }
}
```

The protocol-level `CronJobState` also exposes per-job additive diagnostics:

- `deferredMaintenanceCount`: how many times this job was blocked by the
  current phase.
- `firstDeferredMaintenanceAtMs` / `lastDeferredMaintenanceAtMs`: the
  wall-clock range during which this job was held.

These fields are read-only and are cleared when the phase exits.

## Caveats

- **Single-day windows only.** Cross-midnight schedules are out of scope
  for v2; the schema rejects them with an explicit message.
- **Process-local replay queue.** Restarts during the window drop the
  backlog. Schedule-revision drift handles most of this for cron jobs; for
  one-shots scheduled with `--at`, treat the maintenance window as a window
  in which the one-shot _will not run_.
- **`allowManualRun` is global.** v2 has no per-agent or per-job override;
  a future v3 may add it.

## Configuration reload behaviour

`cron.maintenance.*` is owned by the cron service. The gateway's hot-reload
planner (see `src/gateway/server-reload-hot.ts`) detects a maintenance-block
change and rebuilds `cronState` with `buildGatewayCronService({ cfg: nextConfig, ... })`,
draining the previous service via `stopAndDrain` before publishing the new
one. **No gateway restart is required**: the gateway runtime stays up while
the cron service is replaced in place, and the in-memory maintenance phase
tracking is reset as part of the rebuild.

The same rebuild path covers changes to `agents.defaults.userTimezone` when
that field is the implicit fallback for an omitted `window.timezone`.

Live hot reload of the _deferred backlog_ (jobs that were held when the
window was active) is intentionally not preserved across a cron-service
rebuild: a `clearMaintenanceDeferrals` runs as part of the new service
start. This matches the existing project convention that in-memory
scheduling state is process-local, and is the reason the docs recommend
using a configuration that does not change frequently in production. If
you need to roll the window mid-window, prefer editing the block to widen
or disable the window rather than rewinding it.

## What changed vs #79192

This is a v2 rewrite of the original `feat(cron): add maintenance-window
role isolation` PR (#79192). The original targeted a pre-`#112585`
monolithic `heartbeat-runner` architecture and was closed by ClawSweeper on
2026-08-05 because that architecture has been fully retired on `main`.
This rewrite re-anchors the feature on the new
`heartbeat-cooldown.ts` + `cron monitor rows` + split `cron service`
architecture introduced in upstream.

See the v2 PR description for the full architecture diff.
