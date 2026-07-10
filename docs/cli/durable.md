---
summary: "CLI reference for `openclaw durable` (opt-in durable runtime inspection)"
read_when:
  - Inspecting durable runtime runs, steps, events, refs, signals, timers, or coordination projections
  - Verifying whether the native durable runtime is enabled without mutating state
  - Reviewing durable runtime environment variables, storage, and input retention
title: "`openclaw durable`"
---

Inspect native Durable Runtime state for agent sessions, task runs, steps,
subagent links, signals, timers, refs, and coordination projections.

The durable runtime is opt-in. Unless `OPENCLAW_DURABLE_RUNTIME=1` is set,
`openclaw durable` commands report that the runtime is disabled and do not open,
create, or migrate the shared state database.

## Usage

```bash
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable stats
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable runs
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable runs --limit 25 --json
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable show <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable timeline <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable steps <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable children <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable parents <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable why <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable signals <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable refs <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable timers <runtimeRunId>
OPENCLAW_DURABLE_RUNTIME=1 openclaw durable coordination <runtimeRunId>
```

## Commands

- `stats`: show the durable runtime store path and row counts.
- `runs`: list recent runtime runs.
- `show`: show one run with steps, links, signals, and timeline.
- `timeline`: show ordered durable runtime events for one run.
- `steps`: show durable runtime steps for one run.
- `children`: show child runtime links for one run.
- `parents`: show parent runtime links for one run.
- `why`: explain a run's current durable state, waiting reason, child counts,
  recovery diagnostic, safe next inspection commands, and available controls.
- `signals`: show pending and consumed signals for one run.
- `refs`: show state refs recorded for one run.
- `timers`: show timers for one run.
- `coordination`: show a bounded coordination projection for task or session
  runtime consumers.

All commands support `--json`. `runs` also supports `--limit <count>`.

## Enablement And Storage

Set `OPENCLAW_DURABLE_RUNTIME=1` to enable durable runtime recording and
inspection. Durable runtime state lives in the shared OpenClaw state SQLite
database at `state/openclaw.sqlite`.

When disabled:

- CLI inspection commands return a disabled status.
- Gateway durable coordination RPCs reject requests.
- Agent turn helpers use no-op lifecycle objects.
- The CLI does not create or migrate durable runtime tables.

When enabled, OpenClaw may create or migrate the durable runtime schema in the
shared state database before recording runs or answering durable inspection
queries.

## Environment Variables

| Variable                                     | Default    | Purpose                                                                                                        |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_DURABLE_RUNTIME`                   | disabled   | Enables the durable runtime when set to `1`, `true`, `yes`, or `on`.                                           |
| `OPENCLAW_DURABLE_RUNTIME_STORE`             | `sqlite`   | Selects the durable store backend. Only `sqlite` is supported in this slice.                                   |
| `OPENCLAW_DURABLE_WORKER`                    | disabled   | Starts the recovery worker only when the durable runtime is also enabled.                                      |
| `OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS`   | `1000`     | Worker poll interval.                                                                                          |
| `OPENCLAW_DURABLE_WORKER_CLAIM_TTL_MS`       | `300000`   | Claim lease time for worker-owned runs or steps.                                                               |
| `OPENCLAW_DURABLE_WORKER_MAX_CONCURRENCY`    | `1`        | Maximum worker concurrency for this local-first slice.                                                         |
| `OPENCLAW_DURABLE_RECOVERY_INTERVAL_MS`      | `60000`    | Recovery reconciliation interval.                                                                              |
| `OPENCLAW_DURABLE_STALE_AGENT_TURN_AFTER_MS` | `21600000` | Age after which an unfinished agent turn can be marked lost by recovery.                                       |
| `OPENCLAW_DURABLE_AGENT_TURN_HEARTBEAT_MS`   | `30000`    | Agent turn heartbeat interval. Set `0` to disable the heartbeat timer.                                         |
| `OPENCLAW_DURABLE_ORCHESTRATION_POLICY`      | disabled   | Opt-in prompt guidance for subagent orchestration: `auto`, `solo_first`, `parallel_first`, or `manual_fanout`. |
| `OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS`       | `600`      | Maximum input preview characters stored by default. Set `0` to store metadata only.                            |
| `OPENCLAW_DURABLE_INPUT_TEXT`                | disabled   | Store full input text inline only when set to `full` or `inline`.                                              |
| `OPENCLAW_DURABLE_INPUT_FULL_MAX_CHARS`      | `16384`    | Maximum full input text characters stored when full input retention is enabled.                                |

When `OPENCLAW_DURABLE_ORCHESTRATION_POLICY` is unset, durable orchestration
prompt guidance is enabled only when `OPENCLAW_DURABLE_RUNTIME` is enabled.

## Retention And Privacy

Durable intake records store metadata and a bounded message preview by default.
They do not store full user input unless `OPENCLAW_DURABLE_INPUT_TEXT=full` or
`OPENCLAW_DURABLE_INPUT_TEXT=inline` is set. Operators that need stricter
privacy can set `OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS=0` to store metadata only.

The durable runtime records enough identity, status, recovery state, and state
refs to inspect where work stopped. It does not make automatic retry or resume
decisions by itself in this foundation slice.

## Related

- [Gateway protocol](/gateway/protocol#durable-coordination-rpcs)
- [Durable Core Beta 3 Architecture](/specs/durable-core-beta3-architecture)
- [Durable Core Beta 3 Test Plan](/specs/durable-core-beta3-test-plan)
- [Durable Session and Task Runtime RFC](/specs/durable-session-task-runtime-rfc)
- [CLI reference](/cli)
