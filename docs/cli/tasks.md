---
summary: "CLI reference for `openclaw tasks` (background task ledger and Task Flow state)"
read_when:
  - You want to inspect, audit, or cancel background task records
  - You are documenting Task Flow commands under `openclaw tasks flow`
title: "`openclaw tasks`"
---

Inspect durable background tasks and Task Flow state. With no subcommand,
`openclaw tasks` is equivalent to `openclaw tasks list`.

See [Background Tasks](/automation/tasks) for the lifecycle and delivery model.

## Usage

```bash
openclaw tasks
openclaw tasks list
openclaw tasks list --runtime acp
openclaw tasks list --status running
openclaw tasks show <lookup>
openclaw tasks notify <lookup> state_changes
openclaw tasks cancel <lookup>
openclaw tasks audit
openclaw tasks maintenance
openclaw tasks maintenance --apply
openclaw tasks metadata export
openclaw tasks metadata start --task-id <id> --title <title>
openclaw tasks metadata block --task-id <id> --reason <reason>
openclaw tasks metadata complete --task-id <id> --summary <summary>
openclaw tasks metadata show <id>
openclaw tasks decisions list
openclaw tasks decisions classify --action <action>
openclaw tasks phone-probe "你在干啥"
openclaw tasks phone-probe "有什么要确认"
openclaw tasks phone-probe "继续任务"
openclaw tasks supervision --run-root <path>
openclaw tasks flow list
openclaw tasks flow show <lookup>
openclaw tasks flow cancel <lookup>
```

## Root Options

- `--json`: output JSON.
- `--runtime <name>`: filter by kind: `subagent`, `acp`, `cron`, or `cli`.
- `--status <name>`: filter by status: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, or `lost`.

## Subcommands

### `list`

```bash
openclaw tasks list [--runtime <name>] [--status <name>] [--json]
```

Lists tracked background tasks newest first.

### `show`

```bash
openclaw tasks show <lookup> [--json]
```

Shows one task by task ID, run ID, or session key.

### `notify`

```bash
openclaw tasks notify <lookup> <done_only|state_changes|silent>
```

Changes the notification policy for a running task.

### `cancel`

```bash
openclaw tasks cancel <lookup>
```

Cancels a running background task.

### `metadata`

```bash
openclaw tasks metadata export [--json]
openclaw tasks metadata start --task-id <id> [--title <title>] [--workspace <path>] [--source <source>] [--owner <owner>] [--risk <low|medium|high|hard-boundary>] [--allowed-actions <csv>] [--json]
openclaw tasks metadata block --task-id <id> --reason <reason> [--needs-decision] [--risk <low|medium|high|hard-boundary>] [--json]
openclaw tasks metadata complete --task-id <id> [--summary <summary>] [--json]
openclaw tasks metadata show <id> [--json]
```

Creates and updates explicit safe task metadata for control-plane handoff. This is a small, whitelisted status artifact for local task continuation; it does not read private app transcripts, logs, auth files, caches, or sqlite databases.

### `decisions`

```bash
openclaw tasks decisions list [--json]
openclaw tasks decisions classify --action <action> [--title <title>] [--reason <reason>] [--task-id <id>] [--workspace <path>] [--json]
```

Classifies local actions against the hard-boundary policy. Local, reversible, auditable, explicit-scope actions return `allowed` and write a local allowed-action audit record; destructive deletes, external sends, push/publish/deploy/release, auth/account/payment/credential changes, remote writes/jobs, memory writes, canonical skill/rule/governance mutations, and daemon/cron/monitor creation return `needs_decision` and create a local pending decision packet with action, reason, safe alternative, approval target, and rollback story.

### `phone-probe`

```bash
openclaw tasks phone-probe <text> [--json]
```

Renders the local `openclaw-phone` control reply without sending it to any live phone channel. The supported control texts are `你在干啥`, `有什么要确认`, and `继续任务`. Replies are built only from explicit safe task metadata and the local pending decision queue. `继续任务` reports local, reversible, explicit continuation candidates but does not execute them; hard-boundary tasks stay in the decision queue.

### `supervision`

```bash
openclaw tasks supervision --run-root <path> [--json]
```

Summarizes a Run Harness run from safe artifacts only: task graph, stage manifest, gates, failures, receipts, reviews, and verification. It does not read private logs, prompts, auth material, caches, sqlite files, or raw transcripts. Pending gates are surfaced as blockers with `canAutoApprove: false`.

### `audit`

```bash
openclaw tasks audit [--severity <warn|error>] [--code <name>] [--limit <n>] [--json]
```

Surfaces stale, lost, delivery-failed, or otherwise inconsistent task and Task Flow records. Lost tasks retained until `cleanupAfter` are warnings; expired or unstamped lost tasks are errors.

### `maintenance`

```bash
openclaw tasks maintenance [--apply] [--json]
```

Previews or applies task and Task Flow reconciliation, cleanup stamping, and pruning.
For cron tasks, reconciliation uses persisted run logs/job state before marking an
old active task `lost`, so completed cron runs do not become false audit errors
just because the in-memory Gateway runtime state is gone. Offline CLI audit is
not authoritative for the Gateway's process-local cron active-job set. CLI tasks
with a run id/source id are marked `lost` when their live Gateway run context is
gone, even if an old child-session row remains.

### `flow`

```bash
openclaw tasks flow list [--status <name>] [--json]
openclaw tasks flow show <lookup> [--json]
openclaw tasks flow cancel <lookup>
```

Inspects or cancels durable Task Flow state under the task ledger.

## Related

- [CLI reference](/cli)
- [Background tasks](/automation/tasks)
