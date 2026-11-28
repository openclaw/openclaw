---
name: tag-duplicate-prs-issues
description: Use gitcrawl to search duplicate OpenClaw PRs/issues, group related work in prtags, and sync duplicate state to GitHub.
---

# Tag Duplicate PRs and Issues

Use this skill when a maintainer needs to decide whether a pull request or issue is a duplicate of existing work.

This skill is for maintainer triage and grouping.
It is not for reviewing the implementation quality of a PR.

## Required Setup

Do not write duplicate groups or annotations until this setup is complete.
Read-only discovery can still proceed with `gitcrawl` and live `gh`.

### Companion Skills

Use `$gitcrawl` first for local candidate discovery.
Use the `prtags` skill from the `prtags` repo at `skills/prtags/SKILL.md` when it is available.

### Install the CLIs

When installation is actually needed, read
[the setup procedure](references/setup.md#install-the-clis) in full.

### Authenticate prtags

When authentication is actually needed, read
[the setup procedure](references/setup.md#authenticate-prtags) in full.

## Missing-Setup Rule

Do not require an up-front preflight before starting the workflow.
Proceed with the normal steps until you actually need a tool or account state.

As soon as you discover that `prtags` is missing or not logged in at the write step, stop immediately.
Do not continue in a partial write mode after that point.

If `prtags` is missing, ask the user to run the pinned install command from
[Install the CLIs](references/setup.md#install-the-clis).
Keep that section as the single source of the installed version; do not improvise another install path.

If `prtags auth status` shows that the user is not logged in, ask the user to run:

```bash
prtags auth login
```

Resume only after the missing tool or login state has been fixed.

## Read-Path Default

For candidate discovery in this workflow, use `gitcrawl` first.
Treat it as the local history and clustering layer for related issues, duplicate attempts, and closed threads.

Use live `gh` or `gh api` for the target thread and for any candidate before making an actionable judgment.
Use live GitHub when `gitcrawl` is missing or stale for a concrete reason, such as:

- the target or candidate is not present yet
- the local data is clearly stale or incomplete for the decision you need to make
- `gitcrawl` errors, times out, or lacks the needed neighbor/search data

When you fall back to live GitHub search, note that you did so and why.

If a later `prtags` target-level write fails because its own mirror has not caught up, stop and report that the curation backend is missing the target object instead of forcing a fallback write.

## Goal

For each target PR or issue:

1. gather duplicate evidence
2. decide whether it is a real duplicate
3. create or reuse one `prtags` group for that duplicate cluster
4. save the maintainer judgment in `prtags`
5. rely on normal `prtags` group writes to drive GitHub comment sync when that integration is configured

## Tool Roles

Use the tools with these boundaries:

- `gitcrawl` is candidate generation and historical context
  - use it first for local title/body search, neighbors, clusters, and closed-thread discovery
  - treat every candidate as a lead until live GitHub confirms it
- `gh` is live GitHub truth
  - use it for target state, body, comments, reviews, files, linked issues, and current open/closed/merged status
  - use `gh search` only when `gitcrawl` is stale, missing data, or cannot express the needed query
- `prtags` is the maintainer curation layer
  - use it to create or reuse one duplicate group
  - use it to save the duplicate status, confidence, rationale, and group summary
  - use it as the source of truth for the GitHub-facing group comment

## Working Rules

- Do not call something a duplicate only because the titles are similar.
- Do not call something a duplicate only because the same files changed.
- A duplicate cluster should be based on the same user-facing problem, the same intent, and substantially overlapping implementation or investigation context.

## One-Group Rule

Treat duplicate groups as exclusive.
A PR or issue should belong to at most one duplicate group at a time.

That means:

- before creating a new group, search for an existing group that already represents the same duplicate story
- if the target already appears to belong to a different duplicate group, stop and resolve that conflict first
- do not create a second group for the same target just because the wording is slightly different
- if two plausible existing groups overlap and you cannot safely merge the judgment, stop and ask the maintainer

This rule matters more than speed.
The skill should keep one coherent duplicate cluster per problem, not many near-duplicate clusters.

## What A Good Duplicate Group Represents

A duplicate group should describe the underlying problem and the intended fix direction.
Do not group items only because they share a keyword.

Good group shape:

- same user-facing bug or same maintainer-facing task
- same subsystem or code surface
- same intended change direction
- same likely duplicate-resolution path

Bad group shape:

- “all PRs that touch Slack”
- “all issues mentioning retry”
- “all auth-related items”

The group title should name the real problem.
The group description should summarize the intent and the code surface.

Examples:

- `gateway: startup regression from channel status bootstrap`
- `whatsapp: QR preflight timeout handling`
- `release: cross-OS validation handoff gaps`

## Evidence Checklist

Before declaring a duplicate, gather evidence from at least two categories.
`gitcrawl` neighbors, search hits, and cluster membership count as candidate generation, not as enough proof by themselves.

For PRs:

- same or nearly same problem statement
- same changed files or overlapping file ranges
- same fix direction
- same subsystem and failure mode
- same linked issue or same user-visible symptom

For issues:

- same user-visible problem
- same reproduction story or same failure mode
- same likely fix area
- same PRs already linked or discussed
- same maintainers already steering toward the same duplicate grouping

If you only have wording similarity, that is not enough.

## Step 1: Read The Target

Read [the discovery procedure](references/discovery.md) in full before gathering
or accepting duplicate evidence.

## Step 2: Search Broadly With Gitcrawl

Read [the discovery procedure](references/discovery.md) in full before gathering
or accepting duplicate evidence.

## Step 3: Use Live GitHub Search For Gaps

Read [the discovery procedure](references/discovery.md) in full before gathering
or accepting duplicate evidence.

## Step 4: Decide The Outcome

Choose one of these outcomes:

- `not_duplicate`
- `duplicate_needs_judgment`
- `duplicate_confirmed`

Use `duplicate_confirmed` only when the evidence is strong enough that the maintainer could safely close or retag the duplicate item.

Use `duplicate_needs_judgment` when:

- the problem looks the same but the implementation goal differs
- the code overlap is weak
- the issue wording is ambiguous
- there may be two valid duplicate group interpretations
- the target appears to intersect two existing duplicate groups

## Step 5: Reuse Or Create One prtags Group

Before authorized group, field, annotation, or comment-sync writes, read
[the curation procedure](references/curation.md) in full. Apply the setup and
one-group rules above; group writes own automatic comment sync.

## Step 6: Ensure The Annotation Fields Exist

Before authorized group, field, annotation, or comment-sync writes, read
[the curation procedure](references/curation.md) in full. Apply the setup and
one-group rules above; group writes own automatic comment sync.

## Step 7: Save The Maintainer Judgment In prtags

Before authorized group, field, annotation, or comment-sync writes, read
[the curation procedure](references/curation.md) in full. Apply the setup and
one-group rules above; group writes own automatic comment sync.

## Step 8: Let prtags Sync The Group Comment

Before authorized group, field, annotation, or comment-sync writes, read
[the curation procedure](references/curation.md) in full. Apply the setup and
one-group rules above; group writes own automatic comment sync.

## Output Format

Return a short maintainer report with these sections:

```text
Decision: duplicate_confirmed | duplicate_needs_judgment | not_duplicate
Target: PR #<n> | Issue #<n>
Confidence: high | medium | low

Evidence:
- ...
- ...
- ...

prtags actions:
- reused group <group-id> | created group <group-id>
- added members: ...
- annotations written: ...
- comment sync: automatic if configured | manual repair triggered for <group-id>
```

## Stop Conditions

Stop and escalate instead of forcing a duplicate decision when:

- the target appears to belong to two different duplicate groups
- the duplicate grouping is unclear
- the wording matches but the implementation goals differ
- two PRs touch the same files for different reasons
- two issues describe similar symptoms but likely different root causes

The maintainer should get one clean duplicate judgment or an explicit “needs judgment” result.
Do not blur the line.
