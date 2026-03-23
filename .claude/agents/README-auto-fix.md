# Auto-Fix Agent

## What It Is

An autonomous bug-fixing agent that picks up GitHub issues created by the auto-improve agent, investigates root causes in the codebase, applies minimal fixes, and opens PRs. Only handles bug fixes within defined boundaries — no new features, no architecture changes.

## How It Works

1. **Pick** — Finds the oldest open issue labeled `auto-improve` + `platform`
2. **Investigate** — Searches codebase for the root cause, traces the code path from tool call to error
3. **Scope check** — Verifies the fix is within boundaries (bug fix only, no new features)
4. **Fix** — Creates a branch, makes the minimal fix, adds a regression test when feasible
5. **Test** — Runs `pnpm build && pnpm test`
6. **PR** — Opens a PR linking the issue with root cause analysis and evidence
7. **Log** — Appends to `.claude/skills/auto-fix/data/fixes.tsv`
8. **Next** — Moves to the next open issue

## Relationship to Auto-Improve

The two agents form a closed feedback loop:

- **auto-improve** detects platform issues in session logs and creates GitHub issues
- **auto-fix** picks up those issues and creates PRs
- **auto-improve** verifies post-merge: did the error disappear from session logs?
  - Yes: closes the issue
  - No: reopens with new evidence

## What It Can Fix

Bug fixes only: tool timeouts, MCP connection issues, gateway RPC errors, missing method registrations, session stability issues, tool pipeline failures, schema validation errors.

## What It Cannot Fix

New features, architecture changes, dependency upgrades, UI changes, workspace prompt edits (that's auto-improve's job), database migrations.

## Dispatching

```bash
# Run on-demand
claude agents run auto-fix

# Run in background
claude agents dispatch auto-fix
```

The agent uses model `sonnet` with up to 200 turns per session.

## Results

Tracked in `.claude/skills/auto-fix/data/fixes.tsv` — a tab-separated log of every fix attempt with issue number, category, PR number, status, and description.
