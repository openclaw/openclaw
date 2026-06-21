---
summary: "Durable Beads work graph tracking for long-horizon OpenClaw and Klaw orchestration"
read_when:
  - Planning multi-step agent work with dependencies
  - Replacing worker-state files with a durable work graph
  - Deciding when to use Beads instead of the OpenClaw task ledger
title: "Work tracking"
sidebarTitle: "Work tracking"
---

OpenClaw uses two different records for two different jobs:

- **Tasks** are the runtime activity ledger. They record detached ACP runs, subagents, cron runs, CLI operations, delivery state, and cleanup.
- **Work items** are durable coordination records. They live in Beads and describe what should be done, what blocks it, who owns it, and what the next action is.

Use Beads for long-horizon OpenClaw/Klaw coordination. Do not use `worker-state.json` or another editable projection as the source of truth for active work, dependency state, PR ownership, or next actions.

## Why Beads

Beads gives agents a repo-local issue graph:

- issue types, priorities, labels, assignees, metadata, and external refs
- dependency edges such as `blocks`, `discovered-from`, `parent-child`, and `related`
- `bd ready --json` for unblocked work
- `bd list --json`, `bd show --json`, `bd create --json`, `bd update --json`, and `bd close --json` for agent automation
- repo-local Dolt storage under `.beads`

OpenClaw's `openclaw work` command is a thin bridge over the Beads CLI. It does not copy Beads into OpenClaw SQLite, and it does not make `worker-state.json` authoritative.

## Setup

Install Beads and initialize a workspace:

```bash
npm install -g @beads/bd@1.0.4
bd init
bd status
```

<Note>
Beads `1.0.5` is currently marked as a gated upstream release for multi-machine Dolt sync. Pin `@beads/bd@1.0.4` until upstream publishes a cleared `1.0.6` or later.
</Note>

For an existing shared Beads database, set `BEADS_DIR` before running OpenClaw commands:

```bash
export BEADS_DIR=/path/to/repo/.beads
openclaw work status
```

If Beads is missing or no workspace is initialized, `openclaw work` fails with setup guidance instead of falling back to a local JSON cache.

## Workflow

Create a parent item for a multi-step effort, then create dependent work items for the real units of work:

```bash
openclaw work create "Replace local worker state with Beads" \
  --type epic \
  --priority P1 \
  --label openclaw \
  --label klaw \
  --repo openclaw/openclaw

openclaw work create "Add Beads CLI bridge" \
  --type task \
  --priority P1 \
  --label openclaw \
  --repo openclaw/openclaw \
  --branch klaw/beads-work-tracking \
  --pr-url https://github.com/openclaw/openclaw/pull/123 \
  --next-action "run focused tests" \
  --depends-on <parent-bead-id>
```

Agents should claim from Beads, not from a homegrown projection:

```bash
openclaw work ready --json --label openclaw --metadata repo=openclaw/openclaw
openclaw work claim <bead-id>
openclaw work show <bead-id>
```

When a PR lands or a task is intentionally abandoned, close the Beads item with the reason:

```bash
openclaw work close <bead-id> --reason "merged in PR 123"
```

## Mapping OpenClaw work

Use Beads metadata for operational fields that were previously easy to put in ad hoc worker-state files:

| Field        | Beads location                                   |
| ------------ | ------------------------------------------------ |
| Repository   | `metadata.repo`                                  |
| Branch       | `metadata.branch`                                |
| Pull request | `metadata.prUrl` or `external_ref`               |
| Owner        | Beads assignee or `metadata.owner`               |
| Next action  | `metadata.nextAction` or issue notes             |
| Blockers     | Beads dependency edges                           |
| Ready work   | `bd ready --json` / `openclaw work ready --json` |

Keep OpenClaw task ledger records for runtime execution evidence: task IDs, run IDs, session keys, delivery status, terminal outcome, and cleanup. Link those runtime facts from Beads notes or metadata only when they help coordination.

## Related

- [Background tasks](/automation/tasks)
- [`openclaw work`](/cli/work)
- [`openclaw tasks`](/cli/tasks)
