---
summary: "Nightly technical and business reflection for OpenClaw + Codex with document-only outputs and explicit human approval gates"
owner: "wuji"
status: "draft"
last_updated: "2026-03-13"
title: "Nightly Reflection"
---

# Nightly Reflection

## Overview

This plan defines a low-risk nightly reflection workflow for OpenClaw + Codex.
The goal is to use a quiet window such as 02:00-04:00 local time to review the
day's technical signals and business outcomes when compute is available and user
interaction is low.

The first version must be deliberately conservative:

- write reports only
- propose candidate actions only
- require human confirmation for every follow-up action
- do not change code
- do not update durable memory automatically
- do not modify formal docs automatically

This is a reflection system, not an auto-remediation system.

## Goals

- Produce a nightly technical reflection report from logs and runtime signals.
- Produce a nightly business reflection report from tasks, outcomes, and
  observable user-value signals.
- Turn repeated patterns into explicit candidate knowledge instead of leaving
  them buried in transcripts.
- Make later human review fast by attaching evidence to each conclusion.

## Non-goals

- No automatic code edits.
- No automatic config changes.
- No automatic memory writes to `MEMORY.md` or `memory/*.md`.
- No automatic doc edits in `docs/`.
- No automatic issue filing, PR creation, or message sending without approval.
- No unsupported "AI guessed this probably happened" conclusions without
  evidence.

## Why cron, not heartbeat

This work fits an isolated nightly cron job better than heartbeat.

Reasons:

- the task benefits from a fixed low-traffic window
- it can be compute-heavy and should not compete with normal conversational use
- it should run in isolation instead of polluting the main session
- it is naturally report-shaped rather than chat-shaped

Heartbeat remains a good fit for light ongoing awareness. Nightly reflection is
closer to a scheduled analysis batch.

Related docs:

- [Cron Jobs](/automation/cron-jobs)
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat)
- [Memory](/concepts/memory)
- [Nightly Reflection Prompts](/experiments/plans/nightly-reflection-prompts)

## Two reflection lanes

Nightly reflection should be split into two independent lanes.

### Lane 1: technical reflection

Primary questions:

- where did latency spike
- where did tool calls fail
- where did retries cluster
- where did network or provider instability show up
- where are logs insufficient for diagnosis

Primary artifacts:

- technical incident summary
- repeated-failure pattern list
- candidate reliability improvements
- candidate observability improvements

### Lane 2: business reflection

Primary questions:

- what meaningful situations occurred
- what actions were taken
- what produced real user or operator value
- what should become reusable knowledge next time

Primary artifacts:

- outcome summary
- reusable experience candidates
- candidate memory fragments
- candidate docs or SOP updates

The two lanes should not share a raw conclusion pool. Technical evidence and
business evidence may overlap, but the report sections should stay separate so
signal is easier to review.

## Operating principles

### Principle 1: document first

The first implementation writes structured markdown reports only.

Preferred output shape:

- one technical reflection report per run
- one business reflection report per run
- one short candidate-action appendix per run

### Principle 2: human approval for every action

All follow-up work stays in a candidate state until confirmed by a human.

Examples of actions that must remain gated:

- code changes
- memory writes
- documentation updates
- index tuning
- automation changes
- issue creation
- notifications to external channels

### Principle 3: every conclusion needs evidence

Each important claim should cite the evidence that led to it.

Evidence can include:

- log excerpts or log file references
- tool failure records
- session/transcript references
- repeated runtime events
- prior candidate items that recurred again

If evidence is weak, the report should say so explicitly and downgrade the item
to a hypothesis.

### Principle 4: prefer repeated patterns over one-off noise

One isolated failure is usually worth noting, but not necessarily worth
promotion into explicit knowledge. The nightly workflow should favor:

- repeated events
- clustered failures
- durable workflow lessons
- operational patterns with clear payoff

## Proposed schedule

Suggested first schedule in the user's local time zone:

- 02:15 technical reflection
- 03:00 business reflection
- reserve the rest of 02:00-04:00 for heavy retrieval or indexing work if the
  workflow later grows

Reasons for two separate jobs instead of one larger job:

- easier to reason about failures
- easier to tune prompts independently
- technical and business evidence often use different ranking criteria

## Inputs

The nightly reflection job should read from stable local artifacts first.

### Technical lane inputs

- gateway logs
- agent run logs
- tool call results
- timeout, retry, and abort signals
- network/provider failure records
- sandbox or approval failures
- any existing structured event logs for cron, heartbeat, or isolated runs

Useful clusters to detect:

- repeated provider errors
- slow tool families
- repeated approval dead-ends
- transient network bursts
- sessions with many recoverable failures

### Business lane inputs

- session transcripts for the target period
- message history tied to meaningful user asks
- summaries from completed tasks
- existing memory files when relevant for comparison
- prior report candidates that were later confirmed or rejected

Useful clusters to detect:

- a repeated user problem solved successfully
- a workflow that saved time more than once
- a prompt pattern that improved outcomes
- a missing doc that caused repeated friction
- a recurring operational decision worth turning into a checklist

## Evidence model

Each report item should carry an evidence label:

- `strong`: directly supported by repeated logs or concrete outcomes
- `moderate`: supported by one clear event plus corroborating context
- `weak`: plausible but needs human review before any reuse

Each item should also carry a recommendation type:

- `observe`
- `investigate`
- `document`
- `remember`
- `index`
- `defer`

This keeps the nightly output actionable without silently taking action.

## Output format

The first version should write markdown files into a dedicated report area.

Suggested layout:

```text
reports/reflection/
  YYYY-MM-DD/
    technical.md
    business.md
    candidates.md
```

### Technical report template

Suggested sections:

- date window reviewed
- top anomalies
- repeated failure patterns
- latency or throughput observations
- likely causes
- candidate actions
- evidence appendix

### Business report template

Suggested sections:

- date window reviewed
- notable situations
- actions taken
- concrete gains or outcomes
- reusable lessons
- candidate memory fragments
- candidate docs or SOP updates
- evidence appendix

### Candidate action appendix

Every candidate action should be explicit about status:

- `proposed`
- `needs-human-review`
- `approved` or `rejected` should only be set later by a human workflow

Example candidate classes:

- add a missing log line
- add a troubleshooting doc
- create a memory fragment draft
- adjust retrieval/indexing priorities
- investigate provider instability

## Promotion rules

The system should not immediately promote nightly findings into long-term
knowledge. Promotion should happen only after review.

Suggested promotion ladder:

1. raw observation in nightly report
2. candidate action in `candidates.md`
3. human review
4. approved follow-up such as:
   - memory fragment draft
   - doc update draft
   - issue
   - code task

This preserves a clean boundary between reflection and mutation.

## Guardrails

The workflow must fail closed for side effects.

Required guardrails:

- if approval state is unknown, do nothing beyond report generation
- if evidence cannot be located, mark the item weak or omit it
- if logs are incomplete, say the report is partial
- if a lane fails, keep the other lane independent
- do not rewrite existing memory or docs as part of the nightly run

## Rollout plan

### Phase 0: design only

This document.

### Phase 1: report generation only

Implement the nightly jobs so they:

- collect inputs
- write markdown reports
- produce candidate actions
- produce no side effects beyond local report files

### Phase 2: assisted review loop

After observing report quality for at least a week:

- tighten evidence thresholds
- suppress noisy sections
- improve candidate ranking
- define a small human review ritual for promotion decisions

### Phase 3: approved downstream actions

Only after the review loop is stable:

- allow explicit human-approved promotion into memory, docs, issues, or code
- keep approval as a separate step, not part of the nightly batch itself

## Open questions

- Which exact log sources are stable enough today to support the technical lane
  without extra instrumentation?
- Which session ranges should count as business-relevant versus ordinary chat
  noise?
- Should candidate memory fragments live only in the report at first, or also
  in a separate draft directory?
- What minimum repetition threshold should trigger a `document` or `remember`
  recommendation?

## Recommendation

The best first implementation is a nightly reflection workflow that produces
evidence-backed markdown reports and nothing else.

If the reports are useful for a week, the next step is not "auto-fix more". The
next step is "improve review quality and promotion discipline".
