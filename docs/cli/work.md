---
summary: "CLI reference for `openclaw work` Beads-backed durable work tracking"
read_when:
  - You want to create, claim, list, or close Beads work from OpenClaw
  - You are coordinating OpenClaw/Klaw work across dependencies and PRs
title: "`openclaw work`"
---

Coordinate durable multi-step work with Beads. `openclaw work` delegates to the `bd` CLI with JSON output and keeps Beads as the source of truth for long-horizon planning, dependencies, ownership, and next actions.

Use [`openclaw tasks`](/cli/tasks) for runtime activity records. Use `openclaw work` for the durable work graph.

## Requirements

`openclaw work` requires Beads:

```bash
npm install -g @beads/bd@1.0.4
bd init
```

<Note>
Beads `1.0.5` is currently marked as a gated upstream release for multi-machine Dolt sync. Pin `@beads/bd@1.0.4` until upstream publishes a cleared `1.0.6` or later.
</Note>

If the current repository has no `.beads` workspace, set `BEADS_DIR` to an existing Beads directory.

## Usage

```bash
openclaw work status
openclaw work ready
openclaw work list
openclaw work create <title>
openclaw work claim <id>
openclaw work show <id>
openclaw work close <id>
```

## Subcommands

### `status`

```bash
openclaw work status [--json]
```

Shows whether a Beads workspace is available.

### `ready`

```bash
openclaw work ready [--label <name>] [--metadata <key=value>] [--limit <n>] [--json]
```

Shows unblocked Beads issues using Beads ready-work semantics. Repeat `--label` or `--metadata` to narrow the queue.

### `list`

```bash
openclaw work list [--status <name>] [--all] [--label <name>] [--metadata <key=value>] [--limit <n>] [--json]
```

Lists Beads work items. `--metadata repo=openclaw/openclaw` maps to Beads metadata filtering, not to an OpenClaw cache.

### `create`

```bash
openclaw work create "Fix gateway retry" \
  --type task \
  --priority P1 \
  --label openclaw \
  --repo openclaw/openclaw \
  --branch fix/gateway-retry \
  --pr-url https://github.com/openclaw/openclaw/pull/123 \
  --next-action "wait for CI" \
  --depends-on <bead-id>
```

Creates a Beads issue. OpenClaw-specific options are stored as Beads metadata:

- `--repo <name>` -> `metadata.repo`
- `--branch <name>` -> `metadata.branch`
- `--pr-url <url>` -> `metadata.prUrl` and default external ref
- `--owner <name>` -> `metadata.owner`
- `--next-action <text>` -> `metadata.nextAction`
- `--metadata <key=value>` -> exact Beads metadata

Dependency options create Beads edges:

- `--depends-on <id>` -> `blocks:<id>`
- `--discovered-from <id>` -> `discovered-from:<id>`

### `claim`

```bash
openclaw work claim <id> [--json]
```

Claims a Beads item for the current Beads actor.

### `show`

```bash
openclaw work show <id> [--json]
```

Shows one Beads work item.

### `close`

```bash
openclaw work close <id> [--reason <text>] [--json]
```

Closes a Beads item after the durable coordination work is complete or intentionally superseded.

## Related

- [Work tracking](/automation/work-tracking)
- [Background tasks](/automation/tasks)
- [`openclaw tasks`](/cli/tasks)
