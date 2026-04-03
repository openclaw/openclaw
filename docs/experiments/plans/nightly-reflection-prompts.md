---
summary: "Prompt drafts and report templates for nightly technical and business reflection"
owner: "wuji"
status: "draft"
last_updated: "2026-03-13"
title: "Nightly Reflection Prompts"
---

# Nightly Reflection Prompts

This document is a companion to [Nightly Reflection](/experiments/plans/nightly-reflection).
It defines a practical first-pass prompt set and markdown output templates for a
document-only nightly workflow.

The prompts here intentionally preserve the same safety boundary:

- generate reports only
- do not modify code
- do not modify durable memory
- do not modify formal docs
- do not take any external action
- emit candidate actions only

## Execution model

The first usable version should run two isolated jobs:

- technical reflection
- business reflection

Each job should:

1. gather the target day's local evidence
2. analyze only that evidence
3. write one markdown report
4. avoid all other side effects

An optional third step can merge both reports into a short `candidates.md`
appendix, but that is still document generation only.

## Shared instructions

These instructions should be included in both jobs.

```md
You are running a nightly reflection workflow for OpenClaw.

Hard constraints:

- Write markdown reports only.
- Do not edit source code.
- Do not edit durable memory files such as MEMORY.md or memory/\*.md.
- Do not edit formal docs under docs/.
- Do not create issues, PRs, commits, or outbound messages.
- Do not hide uncertainty. Mark weak conclusions as hypotheses.
- Prefer repeated patterns over isolated noise.
- Attach evidence for every important conclusion.

Required output behavior:

- Produce only the requested markdown report.
- Keep findings actionable and reviewable.
- Every candidate action must remain in proposed state.
```

## Technical reflection prompt

Use this as the first-pass technical lane prompt.

```md
Review the target day's technical runtime evidence for OpenClaw.

Focus on:

- latency spikes
- exceptions and error clusters
- tool call failures
- retry patterns
- network or provider instability
- sandbox or approval failures
- places where logs are too weak to explain a failure

Prioritize:

- repeated failures over one-off noise
- user-visible regressions over internal trivia
- evidence-backed explanations over speculation

For each important item:

- name the symptom
- explain the likely impact
- cite the evidence
- assign evidence strength: strong, moderate, or weak
- propose a next step using one of: observe, investigate, document, remember, index, defer

Do not suggest code changes as already approved work.
Do not write patches.
Do not claim certainty without evidence.

Write the result using the technical reflection report template.
```

## Business reflection prompt

Use this as the first-pass business lane prompt.

```md
Review the target day's business and workflow evidence for OpenClaw.

Focus on:

- meaningful user situations
- what actions were taken
- what produced concrete value
- repeated workflow wins
- repeated friction that suggests missing explicit knowledge
- candidate experience worth preserving as reusable memory or docs later

Prioritize:

- concrete outcomes over vague impressions
- repeatable lessons over isolated anecdotes
- evidence-backed gains over narrative embellishment

For each important item:

- name the situation
- describe the action taken
- describe the concrete gain or outcome
- cite the evidence
- assign evidence strength: strong, moderate, or weak
- propose a next step using one of: observe, investigate, document, remember, index, defer

If a lesson looks useful but is not yet durable enough for long-term memory,
keep it as a candidate only.

Write the result using the business reflection report template.
```

## Candidate merger prompt

If a separate candidate appendix is useful, the merge step can use a very small
prompt like this:

```md
Merge the candidate actions from today's technical and business reflection reports.

Rules:

- keep all items in proposed or needs-human-review state
- deduplicate overlapping items
- preserve evidence references
- separate technical candidates from business candidates
- do not invent new evidence
- do not upgrade anything to approved

Write the result using the candidate appendix template.
```

## Technical reflection report template

```md
# Technical Reflection - YYYY-MM-DD

## Window

- Reviewed window: YYYY-MM-DD 00:00-23:59 local time
- Lane: technical
- Output mode: report only

## Executive Summary

- Summary line 1
- Summary line 2

## Top Anomalies

### 1. Short anomaly title

- Symptom:
- Impact:
- Evidence strength: strong | moderate | weak
- Recommendation type: observe | investigate | document | remember | index | defer
- Evidence:
  - source 1
  - source 2
- Notes:

### 2. Short anomaly title

- Symptom:
- Impact:
- Evidence strength:
- Recommendation type:
- Evidence:
  - source 1
- Notes:

## Repeated Failure Patterns

- Pattern:
- Frequency or recurrence clue:
- Evidence:
- Candidate explanation:

## Latency And Throughput Notes

- Observation:
- Evidence:
- Likely scope:

## Observability Gaps

- Missing signal:
- Why it blocked diagnosis:
- Candidate follow-up:

## Candidate Actions

- [proposed] Title
  - Type: investigate | document | index | observe | defer
  - Why now:
  - Evidence refs:

## Evidence Appendix

- file/log/session reference 1
- file/log/session reference 2
```

## Business reflection report template

```md
# Business Reflection - YYYY-MM-DD

## Window

- Reviewed window: YYYY-MM-DD 00:00-23:59 local time
- Lane: business
- Output mode: report only

## Executive Summary

- Summary line 1
- Summary line 2

## Notable Situations

### 1. Short situation title

- Situation:
- Action taken:
- Outcome or gain:
- Evidence strength: strong | moderate | weak
- Recommendation type: observe | investigate | document | remember | index | defer
- Evidence:
  - source 1
  - source 2
- Notes:

### 2. Short situation title

- Situation:
- Action taken:
- Outcome or gain:
- Evidence strength:
- Recommendation type:
- Evidence:
  - source 1
- Notes:

## Reusable Lessons

- Lesson:
- Why it may generalize:
- Evidence:
- Candidate destination: memory fragment | doc draft | SOP draft | index hint | defer

## Candidate Memory Fragments

- Title:
- Draft summary:
- Why this is not yet approved:
- Evidence refs:

## Candidate Docs Or SOP Updates

- Candidate title:
- Missing knowledge:
- Who it would help:
- Evidence refs:

## Candidate Actions

- [proposed] Title
  - Type: remember | document | index | investigate | defer
  - Why now:
  - Evidence refs:

## Evidence Appendix

- session/transcript reference 1
- session/transcript reference 2
```

## Candidate appendix template

```md
# Reflection Candidates - YYYY-MM-DD

## Status Rules

- All items in this file are proposals only.
- No item is approved by default.
- Human review is required before any follow-up action.

## Technical Candidates

- [needs-human-review] Title
  - Type:
  - Reason:
  - Evidence refs:

## Business Candidates

- [needs-human-review] Title
  - Type:
  - Reason:
  - Evidence refs:

## Deferred Items

- Title
  - Why deferred:
  - Evidence refs:
```

## Suggested file layout

If the first implementation writes local report files, this layout keeps the
artifacts easy to review:

```text
reports/reflection/
  YYYY-MM-DD/
    technical.md
    business.md
    candidates.md
```

If later phases need draft knowledge artifacts, add a separate draft-only area
instead of writing into real memory or docs:

```text
reports/reflection/
  YYYY-MM-DD/
    drafts/
      memory-fragments.md
      docs-notes.md
```

## Review checklist

Before treating a nightly report as useful, verify:

- the report clearly states the reviewed time window
- the report distinguishes fact from hypothesis
- every meaningful finding has evidence
- one-off noise does not dominate the page
- all actions remain unapproved proposals
- no durable files outside the report area were changed

## Recommendation

The fastest safe next step is to wire these prompts and templates into isolated
nightly jobs that generate markdown only. If the reports stay high-signal for a
week, then the workflow is mature enough for a separate human review process.
