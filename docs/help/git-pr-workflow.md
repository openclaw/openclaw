---
title: "Git And PR Workflow"
summary: "Recommended branch, review, and merge discipline for non-trivial OpenClaw changes"
read_when:
  - You are preparing a non-trivial PR
  - You need the repository's preferred review flow
  - You are deciding whether work needs a change-first proposal
---

# Git And PR Workflow

This document captures the repository's preferred Git and PR discipline for
non-trivial work. It is adapted from the workspace governance rules used to
coordinate OpenClaw planning, execution, and owner review.

## Goals

Use a repeatable workflow that keeps scope controlled:

- keep one clear control layer
- keep implementation slices bounded
- make owner review decisive
- avoid mixing governance, runtime state, and unrelated edits in one PR

The goal is not process for its own sake. The goal is to keep PRs reviewable and
merge decisions defensible.

## Roles

### Main Session / Control Layer

Responsibilities:

- confirm the exact problem being solved
- lock what is explicitly out of scope
- decide whether work is docs-only, implementation, or mixed
- summarize review findings and required decisions

### Execution Window

Responsibilities:

- inspect repo, branch, and PR facts
- make bounded changes
- run verification
- commit scoped changes only
- report concrete status and known gaps

### Owner Review Window

Responsibilities:

- review as if acting for the repository owner
- separate blocking issues from non-blocking suggestions
- judge whether the branch is reviewable and merge-ready

### Optional Child Execution Windows

Use only when a subtask is clearly separable and splitting reduces risk or
review overhead.

## Required Flow

### 1. Scope Lock

Before implementation, confirm:

- what problem is being solved
- what success looks like
- what is out of scope for this PR

### 2. Branch And PR Setup

Before editing, check:

- current branch and base branch
- whether this belongs on the current branch or a new one
- whether a PR already exists
- whether the change should be docs-only, code-only, or mixed

### 3. Execute In Bounded Slices

- keep each PR focused on one coherent slice
- avoid bundling unrelated fixes or local experiments
- prefer several reviewable PRs over one oversized PR

### 4. Owner Review Gate

Do not treat a PR as complete just because files changed. A PR is only ready
when:

1. scope is clear
2. review happened
3. approved revisions were applied
4. merge approval exists

### 5. Revise Or Merge

- if review finds blockers, revise first
- if approved, merge cleanly and document the next smallest useful slice

## Change-First Rule

For non-trivial governance or cross-cutting behavior changes, start with a
proposal before implementation.

Use a change-first flow when the work affects:

- root governance files such as `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, or `HEARTBEAT.md`
- repository-wide agent behavior
- review gates or merge policy
- other system-level operating rules

## Repository Hygiene

### Keep Governance Separate From Runtime State

Do not mix repository-governed content with local runtime state. Reviewers
should be able to tell which files belong in version control and which are
machine-local or temporary.

Examples that should stay out of scoped PRs unless explicitly intended:

- local credentials
- caches
- transient logs
- ad-hoc scratch files

### Keep Commits Scoped

- commit only the files required for the slice
- do not stage `.` for convenience when a helper exists to keep staging narrow
- keep commit messages action-oriented and truthful

### Keep PRs Truthful

For bug fixes, include evidence:

- symptom or failing test
- root cause in code
- the changed path that fixes it
- regression coverage or explicit manual verification

## Review Expectations

A good PR summary should state:

- problem
- why it matters
- what changed
- what did not change
- how it was verified

If review comments are addressed, resolve the corresponding review
conversations instead of leaving cleanup to maintainers.

## Recommended Default Pattern

Unless there is a strong reason otherwise, prefer:

- one control layer
- one implementation branch
- one owner review pass
- zero extra child branches

This keeps the workflow understandable and reduces drift.
