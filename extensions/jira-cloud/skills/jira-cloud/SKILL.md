---
name: jira-cloud
description: Plan and execute Jira Cloud workflows for triage, sprint prep, and release follow-up.
metadata: { "openclaw": { "emoji": "🎫" } }
---

Use this skill when the user asks to work with Jira Cloud issues, backlog planning, or release tracking.

## Scope

- Convert unstructured bug reports into actionable Jira issue drafts.
- Propose sprint-ready backlog slices with clear acceptance criteria.
- Build release follow-up checklists from sets of Jira issues.

## Inputs to request early

- Jira project key (example: `OPS`).
- Issue type (`Bug`, `Task`, `Story`, `Epic`).
- Priority and severity expectations.
- Sprint or release target.

## Output format defaults

- Keep outputs copy-paste ready for Jira fields.
- Include:
  - short summary line
  - detailed description
  - acceptance criteria
  - labels/components suggestion
  - risk notes and verification steps

## Triage template

When triaging, produce this structure:

1. Problem statement
2. Impact and affected users
3. Reproduction steps
4. Expected vs actual behavior
5. Technical hypothesis
6. Proposed fix direction
7. Suggested Jira fields

## Sprint planning template

When planning a sprint from a backlog slice:

1. Objectives
2. Candidate issues grouped by theme
3. Dependency/risk map
4. Suggested execution order
5. Definition-of-done checks

## Release follow-up template

After release or cut candidate:

1. Included issues summary
2. Validation matrix
3. Rollback signals
4. Monitoring checklist
5. Post-release actions
