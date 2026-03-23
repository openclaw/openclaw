---
name: auto-fix
description: Evaluation harness for the auto-fix agent. Defines fix boundaries, verification rules, issue-to-PR workflow, and the fixes.tsv tracking format. Use when running the auto-fix agent or reviewing platform bug fix attempts.
---

# Auto-Fix Evaluation Harness

This skill defines the rules for the auto-fix agent — what it can fix, how to verify fixes, and how to track results. The agent reads this skill but never modifies it.

## Verification Script

After fixes are merged, verify if errors have disappeared from session logs:

```bash
# Check if a specific error signature still appears in recent sessions
bun .claude/skills/auto-fix/scripts/check-fixes.ts

# Check a specific issue
bun .claude/skills/auto-fix/scripts/check-fixes.ts --issue 42

# JSON output
bun .claude/skills/auto-fix/scripts/check-fixes.ts --json
```

## Fix Boundary Matrix

The auto-fix agent operates within strict boundaries. This matrix defines what is in and out of scope.

### In Scope (bug fixes only)

| Category          | What Can Be Fixed                                 | Example                                              |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------- |
| tool-timeout      | Adjust timeout values, add retry logic            | MCP tool invoke times out after 10s, increase to 30s |
| mcp-integration   | Fix MCP server connection, tool registration      | MCP server name mismatch, missing tool schema        |
| gateway-rpc       | Fix RPC handler bugs, method registration         | Missing method in server-methods-list.ts             |
| auth              | Fix permission checks, scope assignments          | Method missing from method-scopes.ts                 |
| missing-resource  | Fix path references, file existence checks        | Config path changed but not updated                  |
| schema-validation | Fix schema mismatches, type errors                | Tool input schema rejects valid input                |
| session-stability | Fix session abort causes, error handling          | Unhandled promise rejection crashes session          |
| tool-pipeline     | Fix tool execution pipeline for subagents         | Tool call serialization bug                          |
| escalation        | Investigate prompt-level failures with code roots | Delegation keeps failing despite correct prompts     |

### Out of Scope (never attempt)

| Category                 | Why                                      |
| ------------------------ | ---------------------------------------- |
| New features             | Not a bug fix — requires design/approval |
| Architecture changes     | Too broad, too risky for automated fixes |
| Dependency upgrades      | Can have cascading effects               |
| Performance optimization | Not a bug — separate initiative          |
| UI changes               | Requires design review                   |
| Workspace prompt edits   | That's auto-improve's domain             |
| Database migrations      | Schema changes need manual oversight     |

### Gray Area (attempt with caution)

| Situation                              | Rule                                               |
| -------------------------------------- | -------------------------------------------------- |
| Fix requires adding a new file         | OK if it's a test file. Not OK otherwise.          |
| Fix touches more than 5 files          | Likely too broad. Label `needs-human`.             |
| Fix requires changing a type/interface | OK if backward compatible. Not OK if breaking.     |
| Error is intermittent                  | Add retry/error handling, don't rewrite the logic. |

## Issue Classification

Issues created by auto-improve have these labels:

| Label          | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `auto-improve` | Created by the auto-improve agent (always present)      |
| `platform`     | Platform-level issue, not prompt-level                  |
| `<category>`   | Specific category (tool-timeout, mcp-integration, etc.) |
| `escalation`   | Prompt-level fix failed 3+ times, may need code fix     |
| `needs-human`  | Auto-fix determined it's out of scope                   |

## Issue Priority

Process issues in this order:

1. `severity: high` issues first
2. Among same severity, oldest first (FIFO)
3. Skip issues labeled `needs-human` (already triaged)
4. Skip issues that have an open PR linked (already being fixed)

## Fix Verification

After a fix PR is merged, verification happens in two stages:

### Stage 1: Immediate (auto-improve checks)

The auto-improve agent runs `--diagnostics` each iteration. If the error signature from the issue no longer appears:

- auto-improve closes the issue with a comment: "Error signature no longer detected in N recent sessions. Fix verified."
- auto-improve updates fixes.tsv status to `verified`

If the error persists after 3 iterations post-merge:

- auto-improve reopens the issue with new evidence
- auto-improve updates fixes.tsv status to `failed`

### Stage 2: Regression (ongoing)

If a previously verified fix's error signature reappears in future sessions:

- auto-improve creates a new issue referencing the original
- Labels: `auto-improve, platform, regression, <category>`

## Fixes Tracking Format

File: `.claude/skills/auto-fix/data/fixes.tsv`

Header row (tab-separated):

```
issue	category	severity	pr	status	error_signature	files_changed	description
```

- `issue`: GitHub issue number
- `category`: Issue category (tool-timeout, mcp-integration, etc.)
- `severity`: high, medium, low
- `pr`: PR number (or `-` if out-of-scope)
- `status`: `pr-open`, `merged`, `verified`, `failed`, `out-of-scope`
- `error_signature`: The error signature from the diagnostics
- `files_changed`: Number of files changed in the fix
- `description`: Brief description of the fix

## File Access Rules

| File                                     | Permission                        |
| ---------------------------------------- | --------------------------------- |
| `src/**/*.ts`                            | READ + WRITE                      |
| `*.test.ts`                              | READ + WRITE                      |
| `tsconfig.json`, `vitest.*.ts`           | READ + WRITE                      |
| `.claude/skills/auto-fix/data/fixes.tsv` | READ + WRITE                      |
| `workspaces/**/*`                        | NO ACCESS (auto-improve's domain) |
| `.claude/skills/*/SKILL.md`              | READ ONLY                         |
| `package.json`                           | READ ONLY (no dep changes)        |
| `~/.openclaw/agents/*/sessions/*.jsonl`  | READ ONLY                         |
| Everything else                          | READ ONLY                         |
