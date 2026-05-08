---
summary: "Domain packs define reusable local automation boundaries without changing OpenClaw's core identity"
read_when:
  - Designing reusable automation for a project or life domain
  - Deciding which actions can run locally and which need confirmation
  - Writing pack docs before adding runtime integration
title: "Domain packs"
---

Domain packs describe how OpenClaw can help in a specific domain without making
that domain part of OpenClaw's core identity. A pack is a contract for local
automation: what the pack can inspect, what it can do safely, what evidence it
must leave, and which actions are hard boundaries.

Packs are disabled by default unless a local operator or product surface enables
one for an explicit workspace, project, or routine.

## What belongs in a pack

Use a pack when a domain needs reusable vocabulary, safety rules, evidence, and
rollback notes. Good examples include coding projects, research notes,
health/life routines, document workflows, and repo cleanup.

Do not use packs for one-off chat instructions or global product policy. Core
OpenClaw still owns task state, decisions, phone status, and hard-boundary
classification. Packs provide domain-specific defaults inside those surfaces.

## Safety model

Every pack must declare:

| Field              | Purpose                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `safe_actions`     | Local, reversible, auditable actions OpenClaw may prepare or execute inside the enabled scope              |
| `hard_boundaries`  | Actions that must return `needs_decision` before execution                                                 |
| `evidence`         | Files, receipts, diffs, command output, or status records the pack must leave                              |
| `rollback`         | How to undo or neutralize pack-local changes                                                               |
| `phone_vocabulary` | Short phrases the phone/local control loop can map to pack status, safe continue, or confirmation requests |

External sends, remote jobs, publish/deploy/release, memory writes, account/auth
changes, destructive deletes, and daemon/monitor creation are hard boundaries
unless a future product surface obtains explicit target-level confirmation.

## Markdown truth layer

Before a pack writes durable memory or reaches outside the local machine, it
should create a Markdown truth layer in the enabled workspace. The truth layer
should be readable without OpenClaw running and should include:

- scope and owner;
- current status;
- safe next actions;
- pending confirmations;
- evidence links;
- rollback notes.

For local project packs, this is usually a status note under the project docs or
run directory. For personal routines, it can be a local checklist or review
packet. Durable memory promotion remains a separate confirmed action.

## Related

- [Pack interface](/packs/interface) - required pack fields and action contract
- [Local project maintenance pack](/packs/local-project-maintenance) - starter skeleton
- [Automation and tasks](/automation) - how packs relate to tasks, cron, hooks, and Task Flow
- [Background Tasks](/automation/tasks) - task ledger and hard-boundary decision packets
