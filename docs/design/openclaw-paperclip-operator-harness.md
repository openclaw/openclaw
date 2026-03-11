---
title: OpenClaw Paperclip Operator Harness
description: Architecture spec for using OpenClaw as the operator plane over Linear, Notion, Paperclip, and local coding reviewers.
summary: "Use OpenClaw as the human-facing dispatcher while Paperclip owns execution state, locking, and evidence-backed review."
read_when:
  - Designing an autonomous delivery harness around OpenClaw, Paperclip, Linear, and Notion
  - Implementing an operator-driven workflow with local coding agents and browser-based acceptance testing
  - Defining ticket intake, review gates, evidence collection, and global stop control
---

# OpenClaw Paperclip Operator Harness

## Status

- Draft.
- Intended as the target architecture for a supervised-to-autonomous delivery harness.
- Assumes a local or self-hosted Paperclip deployment, OpenClaw Gateway availability, and local coding agents with browser automation access.

## Summary

OpenClaw is the operator plane.

Paperclip is the execution ledger.

Linear is the upstream backlog.

Notion is the source of design and product context.

Local coding agents do the actual implementation, app boot, browser testing, screenshot capture, and review.

The core design decision is:

- OpenClaw decides what should happen next.
- Paperclip records who owns what, enforces checkout, persists task state, and stores evidence-backed review flow.
- Workers and reviewers run locally in a real repository working directory and must validate work by using the product directly.

This design deliberately avoids making ACP the orchestration substrate. ACP remains an operator bridge and session-control surface via [ACP](/cli/acp), not the backlog engine.

## Goals

- Give the operator one front door: OpenClaw.
- Allow OpenClaw to choose ticket order, dispatch work, request reviews, spot-check progress, and stop the entire system.
- Require implementation and review agents to run the product locally and test it through direct use.
- Make screenshots and video first-class acceptance artifacts, not optional extras.
- Preserve strong execution safety through Paperclip issue state, checkout locking, comments, and audit history.
- Keep product planning in Linear and design truth in Notion.

## Non-Goals

- Replace Linear as the upstream planning system.
- Replace Notion as the source of storyboards, images, and design references.
- Use ACP as a general workflow engine.
- Close tickets based only on code diff or textual self-report.
- Require every reviewer on every ticket regardless of scope.

## High-Level Architecture

```text
Linear -> OpenClaw operator -> Paperclip execution issue -> local worker/reviewer agents -> evidence -> Paperclip -> Linear
                       ^
                       |
                     Notion
```

### Responsibilities

#### OpenClaw

- Human-facing "chief of staff" or operator.
- Reads Linear and Notion context.
- Creates or updates execution issues in Paperclip.
- Decides issue order and when to wake agents.
- Performs spot checks and global halt/resume actions.
- Presents concise operational summaries to the user.

#### Paperclip

- Stores execution issues, status, comments, assignments, and evidence links.
- Enforces checkout and assignee ownership.
- Provides wakeup, pause, resume, and terminate controls for agents.
- Maintains task-scoped session continuity and run history.

#### Linear

- Source of product backlog and planning truth.
- Tracks upstream product state visible to humans.
- Receives summary/status sync from the execution harness.

#### Notion

- Source of product specs, storyboard pages, images, UX notes, and design references.
- Feeds a normalized "spec packet" into each execution issue.

#### Local Coding Agents

- Implement code changes in a real repository checkout.
- Start the application or server locally.
- Use browser automation to validate the product directly.
- Produce screenshots, recordings, logs, and concise review comments.

## Dispatch Authority

There is exactly one dispatch authority: OpenClaw.

Paperclip may still support autonomous heartbeats and wakeups, but Paperclip does not decide queue priority in this design. Paperclip executes and records. OpenClaw dispatches.

### Dispatch Modes

#### 1. Manual

- OpenClaw proposes the next ticket.
- The operator confirms.
- OpenClaw mirrors the ticket into Paperclip and wakes the assigned agent.

#### 2. Dispatch

- OpenClaw selects the next eligible ticket automatically using explicit queue rules.
- OpenClaw wakes the worker without human confirmation.
- Human can intervene at any time.

#### 3. Halt

- OpenClaw pauses Paperclip agents.
- OpenClaw aborts active OpenClaw ACP or Gateway sessions when relevant.
- No new work starts until resumed.

Manual mode should be the initial rollout. Dispatch mode is the target once the evidence and review harness is stable.

## Core Workflow

### Phase 1: Intake

1. A Linear issue is created or updated.
2. OpenClaw reads the issue plus any linked Notion references.
3. OpenClaw builds a normalized execution payload:
   - upstream ticket identifier
   - acceptance criteria
   - startup command
   - healthcheck URL
   - browser walkthrough steps
   - required artifacts
   - required review roles

### Phase 2: Execution Issue Creation

4. OpenClaw creates or updates a Paperclip issue representing execution state.
5. OpenClaw writes a "spec packet" into the Paperclip issue description or comment thread.
6. OpenClaw assigns the execution issue to the chosen worker.

### Phase 3: Implementation

7. OpenClaw wakes the worker in Paperclip.
8. The worker checks out the issue in Paperclip.
9. The worker implements the change in the repo workspace.
10. The worker starts the app or server locally.
11. The worker runs browser-based acceptance testing.
12. The worker captures required artifacts.
13. The worker updates the issue with implementation notes and evidence links.

### Phase 4: Review

14. OpenClaw determines required review roles from ticket scope.
15. OpenClaw creates or activates review subtasks if not already present.
16. OpenClaw wakes the required reviewers.
17. Each reviewer independently:
    - checks out their review issue
    - starts the app if needed
    - uses browser automation to validate the flow directly
    - captures independent screenshots and video
    - leaves a structured review result

### Phase 5: Completion

18. OpenClaw verifies that all required artifacts and review outcomes are present.
19. OpenClaw marks the Paperclip parent issue done.
20. OpenClaw syncs completion status back to Linear.

## Queue Selection Rules

OpenClaw chooses the next ticket using explicit filters, in this order:

1. Blocked operator work first.
2. In-review tickets missing required review completion.
3. Ready tickets with all prerequisites satisfied.
4. Highest priority first.
5. Oldest ready ticket first when priorities tie.

OpenClaw must not dispatch:

- tickets missing a startup command
- tickets missing acceptance criteria
- tickets missing required Notion or design references when the work depends on them
- tickets targeting a repo workspace that is not configured
- tickets requiring reviewers that do not exist

## Issue Model

Each upstream Linear issue maps to one Paperclip parent issue plus zero or more subtasks.

### Parent Issue

Represents the overall delivery unit.

Required fields:

- `externalTicketId`: upstream Linear key, for example `END-123`
- `repoKey`: repository identifier
- `repoCwd`: local checkout path or workspace reference
- `startupCommand`
- `healthcheckUrl`
- `browserWalkthrough`
- `requiredArtifacts`
- `requiredReviewRoles`
- `specPacket`

### Standard Subtasks

- `Implement`
- `UX Review`
- `QA Review`
- `AI Review` when relevant
- `Operator Spot Check` when manually requested

### Review Requirements

#### Always Required

- `QA Review`

#### Required For UI, UX, or Storyboard Work

- `UX Review`

#### Required For Model, Prompting, or AI Behavior Changes

- `AI Review`

### Parent Completion Rule

The parent issue cannot close until:

- the implementation subtask is done
- all required review subtasks are done
- all required artifacts exist
- each required reviewer posted an evidence-backed result

## Spec Packet Contract

OpenClaw must transform Linear plus Notion context into a compact spec packet before waking any agent.

The spec packet must contain:

- issue summary
- exact acceptance criteria
- direct links to upstream Linear and Notion references
- a short list of relevant screens or flows
- image references if applicable
- startup command
- healthcheck URL
- browser walkthrough
- artifact requirements
- review matrix

The spec packet is the execution contract. Agents should not need to search for basic task definition after the issue starts.

## Execution Contract

Every executable ticket must define the following:

### Repository Context

- repository name
- working directory
- base branch
- optional environment prerequisites

### Startup Contract

- exact command to boot the app or service
- expected healthy URL or signal
- expected seed data or login state if needed

### Browser Walkthrough

An ordered list of user-facing validation steps, for example:

1. Open sign-in page.
2. Authenticate with test account.
3. Open target screen.
4. Execute changed flow.
5. Verify acceptance outcome.

### Artifact Contract

Artifacts are required, not optional.

Minimum artifact set:

- `before.png`
- `after.png`
- `annotated.png`
- `walkthrough.webm`
- `serve.log`
- `review.md`

Recommended additional artifacts:

- diff screenshot output
- console error capture
- network trace when relevant
- mobile screenshot set for responsive changes

## Browser Testing Requirements

Direct use of the product is the primary validation mechanism.

All implementation and review agents must be able to:

- start the app locally
- navigate to the target flow
- drive the UI using browser automation
- capture screenshots
- capture a video walkthrough

The preferred tool is `agent-browser`.

### Browser Session Rules

- Use one isolated browser session per issue and per agent.
- Re-run the actual user flow after code changes.
- Re-run the actual user flow independently during review.
- Use annotated screenshots where element identification matters.
- Record a walkthrough for all customer-facing UI changes.

### Review Independence Rule

Reviewer artifacts must be independently generated.

Builder-provided screenshots can support context, but they do not satisfy review completion on their own.

## Agent Topology

### OpenClaw Operator

Purpose:

- intake
- dispatch
- status
- spot checks
- stop and resume control

Capabilities:

- read Linear
- read Notion
- read and update Paperclip
- optionally attach to ACP sessions

### Builder

Purpose:

- implement code
- start the app
- run browser validation
- capture evidence

Requirements:

- local repo access
- write access
- process execution
- browser automation access

### UX Reviewer

Purpose:

- validate visual quality and interaction fidelity against storyboard or product intent

Requirements:

- local repo access
- process execution
- browser automation access
- screenshot and video capture

### QA Reviewer

Purpose:

- validate core correctness, regressions, and acceptance criteria

Requirements:

- local repo access
- process execution
- browser automation access
- screenshot and video capture

### AI Reviewer

Purpose:

- validate model behavior, prompting, data handling, and AI quality when the ticket affects AI functionality

Requirements:

- local repo access when app verification is needed
- browser automation when user-facing AI flows are affected

## OpenClaw Control Surface

OpenClaw should expose a small, explicit operator command set.

### Required Commands

- `status`
  - summarize queue state, active runs, blocked work, pending reviews, and missing evidence

- `start-ticket <key>`
  - create or refresh the Paperclip execution issue and wake the builder

- `next-ticket`
  - select the next eligible ticket using queue rules and dispatch it

- `request-review <key>`
  - wake required reviewers for the specified issue

- `spot-check <key>`
  - independently boot the app, run the browser flow, and attach results

- `pause-all`
  - pause Paperclip agents and stop new work from starting

- `resume-all`
  - resume paused Paperclip agents

- `stop-all`
  - pause or terminate relevant Paperclip agents and abort active operator sessions when needed

## Paperclip Control Surface

OpenClaw needs a Paperclip control skill or equivalent adapter with the following minimum actions:

- list issues by status and assignee
- get issue details and comments
- create issue
- update issue
- add comment
- create or link review subtasks
- wake specific agent
- pause, resume, terminate agent
- inspect run status

OpenClaw should not bypass Paperclip issue state when work is already represented there.

## ACP Role

ACP remains useful, but only in a bounded role.

Use [ACP](/cli/acp) for:

- giving OpenClaw an operator bridge into managed sessions
- attaching to active work for spot checks or intervention
- stopping or cancelling active OpenClaw-managed sessions

Do not use ACP as:

- the backlog queue
- the review ledger
- the evidence system
- the dispatch state machine

## Status Mapping

### Linear -> Paperclip

- `Backlog` -> `backlog`
- `Todo` -> `todo`
- `In Progress` -> `in_progress`
- `In Review` -> `in_review`
- `Done` -> `done`
- `Blocked` -> `blocked`
- `Cancelled` -> `cancelled`

OpenClaw is responsible for any mapping between upstream Linear workflow nuance and Paperclip execution semantics.

## Evidence Policy

No execution issue may close without evidence.

### Minimum Evidence Checklist

- implementation note
- startup confirmation
- successful browser walkthrough
- screenshots
- video recording
- reviewer comments

### Evidence Storage

The exact storage backend is implementation-specific, but the execution issue must contain durable references to the artifact set.

## Rollout Plan

### Phase 0: Manual Pilot

- One repository
- One builder
- One QA reviewer
- One UX reviewer
- OpenClaw dispatch only after human confirmation

### Phase 1: Structured Dispatch

- OpenClaw auto-selects the next ticket using queue rules
- Review subtasks generated automatically
- Evidence checklist enforced before close

### Phase 2: Operator Autopilot

- OpenClaw dispatches continuously
- Human remains available for pause, resume, stop, and spot checks
- Periodic operator summaries surface risk and failures

## MVP Implementation Scope

The initial implementation should include:

- a Paperclip control skill or extension for OpenClaw
- a spec-packet generator using Linear plus Notion context
- one builder agent and two reviewer agents with local repo access
- a strict artifact contract
- operator commands for `status`, `start-ticket`, `next-ticket`, `spot-check`, `pause-all`, `resume-all`, and `stop-all`

The initial implementation should not include:

- multi-repo generalization
- full automatic prioritization heuristics beyond explicit queue rules
- broad reviewer matrices
- complex policy inference from incomplete ticket data

## Open Questions

- Where should artifact files live by default: repo-local, shared workspace, or Paperclip-managed storage?
- Should OpenClaw mirror artifacts back into Linear comments automatically?
- Should Notion images be copied into the execution issue or linked only?
- Should the operator maintain one global queue across repos or one queue per repo?
- Should spot checks always create a dedicated Paperclip subtask for traceability?

## Acceptance Criteria For This Spec

This spec is successful if the resulting harness can:

- ingest a Linear ticket with linked design context
- generate a complete spec packet
- dispatch work through OpenClaw into Paperclip
- run implementation locally in a repo
- validate the product through browser automation
- collect screenshots and video
- require independent reviewer validation
- pause, resume, or stop the system from OpenClaw

## References

- [ACP](/cli/acp)
- [Gateway Heartbeat](/gateway/heartbeat)
- [Gateway Protocol](/gateway/protocol)
- [CLI Agents](/cli/agents)
