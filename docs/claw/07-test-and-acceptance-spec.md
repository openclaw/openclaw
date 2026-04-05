---
title: "Claw v1 Test and Acceptance Spec"
summary: "Scenario matrix and release bar for Claw v1."
read_when:
  - You need to know what must pass before Claw v1 is considered complete.
  - You are writing tests for mission lifecycle, governance, or browser hardening.
  - You need the acceptance matrix for manual or automated verification.
status: active
---

# Claw v1 Test and Acceptance Spec

## Purpose

This document defines the must-pass scenario matrix for Claw v1. A subsystem is not complete just because it has code. Claw v1 is complete only when the behaviors in this document work end to end.

## Acceptance themes

Claw v1 acceptance is organized around these themes:

- mission creation and approval
- full-access behavior
- UI and gateway consistency
- UI-closed persistence
- recovery after restart
- blocker handling
- browser/runtime stability
- governance and audit

## Mission creation and approval

Required scenarios:

1. create a goal from the UI and get a draft mission
2. see mission packet fields populated
3. see preflight findings in `PRECHECKS.md`
4. remain in `awaiting_setup` when required setup is missing
5. move to `awaiting_approval` when ready
6. approve start once and transition to `queued`
7. start automatically when a queue slot opens

## Full-access behavior

Required scenarios:

1. mutate files inside the primary root after approval
2. mutate files outside the primary root after approval
3. run host shell commands after approval
4. launch and manage background processes
5. use browser actions after approval
6. use subagents and session orchestration
7. use gateway or cron capability when mission-implied

Expected result:

- no routine approval prompt after mission start approval

## UI and gateway consistency

Required scenarios:

1. `Missions` view updates when mission state changes
2. `Mission Detail` reflects the latest phase, artifacts, and verification state
3. `Inbox` reflects pending decisions without browser-local drift
4. `Audit` view updates when new audit entries are appended
5. sequence gap or reconnect triggers correct rehydration

## UI-closed persistence

Required scenarios:

1. close the UI during an active mission and verify mission continues
2. reopen the UI and verify mission state is reconstructed correctly
3. generate a blocker while UI is closed and verify the inbox contains it on reopen
4. complete a mission while UI is closed and verify the result is visible on reopen

## Recovery after restart

Required scenarios:

1. restart during `queued` and verify queued state survives
2. restart during `running` and verify mission enters `recovering`
3. restart during background process execution and verify reconciliation occurs
4. restart during browser-backed work and verify browser state is reconciled or blocked honestly
5. restart during external mutation and verify recovery uncertainty is surfaced when needed

## Blocker handling

Required scenarios:

1. missing credential before start -> `awaiting_setup`
2. expired credential during execution -> `blocked`
3. interactive login or CAPTCHA -> `blocked`
4. missing plugin or device -> preflight finding or `blocked`, depending on timing
5. failing tests or transient command failures do not create operator blockers by themselves

## Browser and runtime stability

Required scenarios:

1. cold `browser status`
2. cold `browser start`
3. tab open and follow-up action
4. multi-step browser flow without premature timeout
5. gateway restart on Windows without SIGUSR1-style failure

Acceptance bar:

- repeated runs must not fail from the current short-budget timing issues alone

## Governance and audit

Required scenarios:

1. `pause all` pauses active missions gracefully
2. `stop all now` interrupts active work and freezes queue admission
3. `autonomy off` blocks auto-start and auto-resume
4. audit entries are appended for local mutations
5. audit entries are appended for external mutations
6. no-progress loop triggers governance action before silent endless looping

## Minimum release bar

Claw v1 is ready only when:

- all core mission lifecycle scenarios pass
- all full-access scenarios pass
- UI-closed persistence passes
- restart recovery passes
- browser hardening scenarios pass on Windows
- governance controls and audit visibility pass

Failure in any one of those categories blocks release.

## Related specs

- [Claw v1 Master Spec](/claw/00-master-spec)
- [Full Access Semantics Spec](/claw/01-full-access-semantics-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [Browser and Runtime Hardening Spec](/claw/04-browser-and-runtime-hardening-spec)
- [Governance and Audit Spec](/claw/06-governance-and-audit-spec)
