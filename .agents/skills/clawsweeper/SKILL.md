---
name: clawsweeper
description: "Inspect ClawSweeper reports, request reviews, diagnose queue or dispatch health, and identify retired commands."
---

# ClawSweeper

ClawSweeper reviews issues and pull requests across OpenClaw repositories.
Its canonical source is [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper).
Resolve the actual local checkout instead of assuming its path.

## Start

Inspect `git status --short --branch` in the ClawSweeper checkout. Status and
report requests stay read-only: use current reports and live read APIs when
freshness matters, without pulling or building just to inspect them.

For authorized implementation or execution, update a clean task-owned checkout
and build only when the selected command needs it. Preserve unrelated edits
and other operators' active workflows.
Read that checkout's `AGENTS.md` before execution.

## One Bot, One App

Use the `clawsweeper` GitHub App and current `CLAWSWEEPER_*` configuration.
The source repository owns App setup and permissions. Do not change credentials,
permissions, or execution gates for a status request.

Review workers propose findings with stripped secret/token environments.
Deterministic workflows own comments, labels, and guarded close proposals.
A review result does not authorize a separate mutation.

## Hosted Commit Reviews

Hosted per-commit reports and commit Check Runs are retired. For the retained
offline review of a committed branch, use `pnpm local-review -- --base main`.
`$autoreview --mode commit --commit <sha>` remains a separate general-purpose
review path.

## Sweep Reports

Canonical issue/PR report keys are:

```text
records/<repo-slug>/items/<number>.md
records/<repo-slug>/closed/<number>.md
```

The Worker store owns current records. Verify freshness before relying on a
local copy. Lead with counts, concrete findings, and report links.
Do not post unsolicited GitHub comments from report-reading work.

PR reports include `reviewFindings` with priority, confidence, repository-relative
file, and line range. Public comments show short findings and collapsed review
details. Read the durable result rather than inferring coverage from labels.

For a simple status request, read existing reports and bounded live workflow
state. Use `pnpm run audit` only for a requested full audit.

Reconciliation is a separate authorized mutation: bare `pnpm run reconcile`
moves/deletes report and work-plan files. Inspect its dry-run only when that
maintenance task is requested. Likewise, `apply-decisions` belongs to an
explicitly authorized apply workflow, beginning with its dry-run.

## Maintainer Mentions

Prefer the supported mention commands:

```text
@clawsweeper review
@clawsweeper re-review
@clawsweeper explain
@clawsweeper stop
@clawsweeper help
```

`review` and `re-review` request a fresh read-only issue/PR review.
`explain` summarizes current status. Review commands can include read-only focus
context. Arbitrary freeform questions and action requests do not start repair.

Item authors can use `re-review` or `re-run` on their own open items.
The router checks current comment identity and repository permissions.
Repository membership alone does not establish command authority.

`stop` establishes the human-review hold before removing old repair-loop labels.
Let that supported command own the transition. Do not remove protection labels
manually to reproduce it.

Start an authorized comment-routing task with its dry-run:

```bash
pnpm run repair:comment-router -- --repo openclaw/openclaw --lookback-minutes 180
```

The command defaults to dry-run. Scheduled routing stays dry unless
`CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1`. Use `--execute` only for an authorized
routing task. Do not toggle or reset gates as generic cleanup.

## Retired Commands And Protected State

Repair, autofix, automerge, issue implementation, fix-ci, address-review, rebase,
and approve commands are retired. `@clawsweeper status` is also retired.
Use `@clawsweeper explain`. The removed repair job creation, validation, dispatch,
and executor entrypoints are unavailable.

For authorized code repairs and landing, follow the
[maintainer workflow](../openclaw-pr-maintainer/SKILL.md).
Do not treat a retired command or label as execution or merge authority.

Existing `clawsweeper:autofix` and `clawsweeper:automerge` labels still protect
items from automatic closure. Preserve those holds, active or unknown owners,
leases, locks, receipts, and recovery evidence. Retirement alone authorizes no
cleanup or adoption. Remaining `repair:` tooling supports reviews, publication,
and maintenance. Its name does not restore repair execution.

## Security Boundary

Route vulnerability reports and sensitive disclosures through
[OpenClaw security handling](../../../SECURITY.md).
A review result or retired repair label does not waive security approval,
source trust, required review, or native merge gates.

## Monitoring

Distinguish intake success from an active review using the
[review-admission guidance](../../../docs/reference/pull-request-review-flow.md#clawsweeper).

Receiver workflows:

```bash
gh run list --repo openclaw/clawsweeper --workflow sweep.yml \
  --limit 12 --json databaseId,displayTitle,event,status,conclusion,createdAt,updatedAt,url
gh run list --repo openclaw/clawsweeper --workflow repair-comment-router.yml \
  --limit 12 --json databaseId,displayTitle,event,status,conclusion,createdAt,updatedAt,url
gh run list --repo openclaw/clawsweeper --workflow github-activity.yml \
  --limit 12 --json databaseId,displayTitle,event,status,conclusion,createdAt,updatedAt,url
```

Target dispatcher:

```bash
gh run list --repo openclaw/openclaw --workflow "ClawSweeper Dispatch" \
  --limit 8 --json databaseId,displayTitle,event,status,conclusion,headSha,url
```

## Reading Output

For findings or failures, summarize:

- target repo, item/PR, run, report key
- result, confidence, severity, and exact blocker
- affected files and validation results
- actual mutation authority and next deterministic action.
