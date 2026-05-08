---
summary: "Required interface for OpenClaw domain packs"
read_when:
  - Creating a new domain pack
  - Reviewing whether pack actions are auditable and gated
  - Mapping phone commands to pack-local actions
title: "Pack interface"
---

A domain pack is a small manifest plus supporting docs. The manifest is a
declarative contract; it does not grant authority by itself. OpenClaw evaluates
pack actions through the same task metadata and decision surfaces used by the
rest of the control plane.

## Manifest shape

```yaml
id: local-project-maintenance
title: Local project maintenance
version: 0.1.0
status: draft
scope:
  kind: workspace
  defaultRoot: "."
  requiredMarkers:
    - ".git"
owners:
  - local-operator
safe_actions:
  - id: inspect_status
    title: Inspect local status
    risk: low
    allowedWhen:
      - workspace is explicitly enabled for this pack
      - command is read-only
    evidence:
      - status summary
  - id: prepare_cleanup_packet
    title: Prepare cleanup packet
    risk: low
    allowedWhen:
      - changes are proposed in Markdown only
      - no files are deleted or overwritten
    evidence:
      - cleanup packet path
hard_boundaries:
  - id: destructive_delete
    decision: needs_decision
  - id: external_send
    decision: needs_decision
  - id: remote_job
    decision: needs_decision
  - id: publish_deploy_release
    decision: needs_decision
  - id: memory_write
    decision: needs_decision
evidence:
  truthLayer: "docs/status/local-project-maintenance.md"
  receipts:
    - local command summary
    - changed file list
    - pending decision list
rollback:
  strategy: local_diff_reversal
  notes:
    - Revert pack-created docs or patches from the recorded file list.
    - Do not revert unrelated user or parallel-worker changes.
phone_vocabulary:
  status:
    - "这个项目现在怎么样"
    - "项目维护状态"
  continue_safe:
    - "继续本地维护"
    - "把安全的继续做"
  decisions:
    - "有什么要确认"
    - "哪些维护动作卡住了"
```

## Required fields

| Field              | Required | Notes                                                                                                                                       |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Yes      | Stable lowercase identifier                                                                                                                 |
| `title`            | Yes      | Human-readable pack name                                                                                                                    |
| `version`          | Yes      | Pack contract version                                                                                                                       |
| `status`           | Yes      | `draft`, `enabled`, `deprecated`, or `retired`                                                                                              |
| `scope`            | Yes      | Where the pack may inspect or prepare local work                                                                                            |
| `safe_actions`     | Yes      | Local, reversible, auditable actions only                                                                                                   |
| `hard_boundaries`  | Yes      | Must include external sends, remote jobs, publish/deploy/release, memory writes, destructive deletes, and persistent monitors when relevant |
| `evidence`         | Yes      | Required truth layer and receipts                                                                                                           |
| `rollback`         | Yes      | Operator-readable reversal story                                                                                                            |
| `phone_vocabulary` | Yes      | Phrases grouped by status, safe continuation, and decisions                                                                                 |

## Action contract

Safe actions may run only when all of these are true:

- the pack is enabled for an explicit scope;
- the action is local to that scope;
- the action is reversible or produces a proposal only;
- the action leaves evidence in the declared truth layer or receipt path;
- the action does not cross any declared hard boundary.

When an action crosses a hard boundary, the pack must return a decision packet
instead of executing the action. The packet should include the requested action,
reason, safe alternative, approval target, expected evidence, and rollback
story.

## Evidence expectations

Pack evidence should be boring and replayable. A reviewer should be able to see
what the pack looked at, what it changed or proposed, what remains blocked, and
how to undo the local work.

Minimum evidence for a pack run:

- pack id and version;
- enabled scope;
- safe actions attempted;
- hard-boundary actions blocked;
- file list for created or edited local artifacts;
- verification commands or manual checks;
- rollback notes.

## Phone vocabulary

Phone vocabulary is intentionally plain-language. It should not expose internal
gate ids as the first answer. The phone/local control loop can still include gate
ids as supporting detail after it explains the user-facing decision.

Recommended groups:

| Group           | Meaning                                         |
| --------------- | ----------------------------------------------- |
| `status`        | Summarize what the pack currently knows         |
| `continue_safe` | Continue only local, reversible, auditable work |
| `decisions`     | Show blocked hard-boundary actions              |
| `evidence`      | Show receipts or truth-layer paths              |
| `rollback`      | Explain how to undo pack-local changes          |

## Non-goals

The pack interface does not activate cron jobs, daemons, external delivery,
remote compute, publication, deployment, or memory writes. Those remain separate
product surfaces with explicit confirmation requirements.
