---
name: eng-codex
description: >
  Implement features, fix bugs, or run tests autonomously using Codex CLI.
  Three-phase workflow: research → plan → implement. Git worktree isolation.
  Accepts owner/repo and optional Linear issue ID. Works on any software project.
user-invocable: true
requires-bins: [codex, git, python3, openssl, bash]
requires-auth: ~/.codex/auth.json (OAuth tokens, not API key)
---

## When to Invoke This Skill

- User or cos agent sends a feature request, bug fix, or test task with a clear owner/repo
- A Linear issue has been dispatched and is in Ready state
- eng agent classifies a task as implementation-ready

## Inputs

| Variable          | Required | Description                                                                |
| ----------------- | -------- | -------------------------------------------------------------------------- |
| `TASK`            | Yes      | Description of what to implement                                           |
| `OWNER_REPO`      | Yes      | GitHub owner/repo, e.g. `sebbyyyywebbyyy/my-app` or `Outta-Bounds/product` |
| `TASK_ID`         | No       | Auto-generated from timestamp if omitted                                   |
| `LINEAR_ISSUE_ID` | No       | Triggers status update to Done on completion                               |
| `COMPLEXITY`      | No       | `trivial` \| `standard` \| `complex` (default: `standard`)                 |

Always specify `OWNER_REPO` explicitly — do not guess from context.

## Execution Strategy

### Trivial Tasks (< 1 file, clear fix)

Single Codex invocation. No separate research/plan phases. Runs directly in a worktree.

### Standard Tasks (1-5 files, clear requirements)

Three separate Codex invocations, each with a fresh context:

**Phase 1 — Research**
Explore the repo. Identify relevant files, data flows, existing patterns, risks.
Write findings to `.eng/research-{TASK_ID}.md`.

**Phase 2 — Plan**
Read the research file. Produce a numbered implementation plan.
Write to `.eng/plan-{TASK_ID}.md`.

**Phase 3 — Implement**
Read the plan. Execute steps sequentially.
Checkpoint every 3-5 steps to `.eng/progress-{TASK_ID}.md`.
Run tests after each implementation block.

### Complex Tasks (> 5 files or ambiguous)

Same as Standard, but decompose into subtasks first. Each subtask gets its own worktree.
Integration-test after all subtasks complete.

## After Execution

1. Invoke `eng-reviewer` on the new commit
2. If review passes: post commit hash + summary to Discord, update Linear if issue ID provided
3. If review fails: run one fix pass via Codex, re-review (max 2 iterations before escalating)
4. On doom-loop (same error 3×): stop, report to Discord with error context
5. Update `.eng/memory/{module}.md` with any patterns discovered

## Error Handling

- Missing `~/.codex/auth.json` or empty token: fail immediately, do not proceed
- Missing `codex` binary: fail immediately
- Dirty workspace in target repo: fetch + stash if needed, or abort and report
- Worktree kept on failure at `/tmp/worktrees/{TASK_ID}` for debugging

## Running the Skill

```bash
# Standard task
OWNER_REPO="sebbyyyywebbyyy/my-app" \
TASK="Add health check endpoint at /api/health returning {status: ok}" \
LINEAR_ISSUE_ID="ENG-123" \
bash ~/.openclaw/workspace-engineering/skills/eng-codex/run_codex.sh "$TASK" "$OWNER_REPO"

# Or from the workspace skill path (if skill is in openclaw source):
bash /app/skills/eng-codex/run_codex.sh "$TASK" "$OWNER_REPO"
```
