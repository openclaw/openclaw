---
summary: "Starter domain pack skeleton for safe local project maintenance"
read_when:
  - Starting a local project maintenance pack
  - Preparing repo cleanup or status work without destructive actions
  - Testing pack evidence and phone vocabulary
title: "Local project maintenance pack"
---

The local project maintenance pack is a starter skeleton for inspecting and
preparing safe work inside a single local workspace. It is useful for repo
cleanup, run-state review, documentation handoff, and low-risk maintenance
packets.

This pack does not delete files, publish changes, push branches, submit remote
jobs, send external messages, write memory, or create daemons.

## Pack manifest

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
  deniedPaths:
    - ".env"
    - ".git"
    - "node_modules"
    - "dist"
    - "dist-runtime"
    - "coverage"
owners:
  - local-operator
safe_actions:
  - id: inspect_status
    title: Inspect local project status
    risk: low
    allowedWhen:
      - workspace is explicitly selected
      - command is read-only
      - private app logs, auth, caches, and raw transcripts are not read
    evidence:
      - status summary
      - relevant file list
  - id: prepare_review_packet
    title: Prepare review packet
    risk: low
    allowedWhen:
      - output is Markdown only
      - no external write occurs
    evidence:
      - review packet path
  - id: propose_cleanup_plan
    title: Propose cleanup plan
    risk: low
    allowedWhen:
      - cleanup is proposed, not applied
      - uncertain files are listed for decision
    evidence:
      - proposed delete/archive list
      - preserve list
      - uncertainty list
  - id: run_targeted_local_check
    title: Run targeted local check
    risk: low
    allowedWhen:
      - check is scoped to the pack workspace
      - check has no network, publish, deploy, daemon, or remote-job side effect
    evidence:
      - command summary
      - pass/fail result
hard_boundaries:
  - id: destructive_delete_or_purge
    decision: needs_decision
    examples:
      - deleting files
      - purging caches when recovery value is uncertain
      - rewriting unrelated user changes
  - id: external_send
    decision: needs_decision
    examples:
      - email, chat, issue, PR, webhook, or phone delivery
  - id: remote_job_or_write
    decision: needs_decision
    examples:
      - cluster job submission
      - remote filesystem write
      - remote API mutation
  - id: publish_deploy_release
    decision: needs_decision
    examples:
      - push
      - deploy
      - package publish
      - release
  - id: memory_write
    decision: needs_decision
    examples:
      - Codex memory update
      - OpenClaw durable memory promotion
  - id: persistent_monitor
    decision: needs_decision
    examples:
      - daemon
      - cron
      - heartbeat monitor
evidence:
  truthLayer: "docs/status/local-project-maintenance.md"
  receipts:
    - "receipts/local-project-maintenance.md"
    - "reviews/local-project-maintenance.md"
    - "verification/local-project-maintenance.md"
rollback:
  strategy: local_patch_reversal
  notes:
    - Remove or revert only files created by this pack run.
    - For edited files, use the recorded file list and diff.
    - Never revert unrelated user or parallel-worker changes.
    - For proposed cleanup packets, rollback is deleting the packet.
phone_vocabulary:
  status:
    - "这个项目现在怎么样"
    - "项目维护状态"
    - "本地维护进展"
  continue_safe:
    - "继续本地维护"
    - "把安全的继续做"
    - "只做本地可回滚的"
  decisions:
    - "有什么要确认"
    - "哪些维护动作卡住了"
    - "哪些不能自动做"
  evidence:
    - "给我维护证据"
    - "看一下收据"
  rollback:
    - "怎么撤回"
    - "回滚路径是什么"
```

## Safe starter workflow

1. Confirm the workspace root and pack id.
2. Inspect only explicit project files and allowed run artifacts.
3. Write or update a Markdown truth layer.
4. Prepare review packets for cleanup or maintenance.
5. Run targeted local checks when they are local and side-effect-free.
6. Return `needs_decision` for any hard-boundary action.

## Example truth layer

```markdown
# Local Project Maintenance Status

Pack: local-project-maintenance@0.1.0
Scope: /path/to/project
Updated: 2026-05-08T00:00:00Z

## Safe Actions Completed

- Inspected local status.
- Prepared cleanup review packet.

## Pending Decisions

- Delete generated build output: needs decision.
- Push branch: needs decision.

## Evidence

- receipts/local-project-maintenance.md
- reviews/local-project-maintenance.md
- verification/local-project-maintenance.md

## Rollback

Remove pack-created Markdown packets or revert only the recorded patch.
```

## Activation boundary

This page is a skeleton, not an active automation. Enabling it in a product
surface should require explicit scope selection and should still route every
hard-boundary action through the decision queue.
