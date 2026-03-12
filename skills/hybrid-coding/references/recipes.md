# Execution Recipes

## Recipe 1: Single Task (most common)

```bash
# Claude Code call
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect 'Add pagination to src/api/comments.ts'"

# Verify
exec workdir:"C:\TEST\MAITOK" command:"npx tsc --noEmit"
exec workdir:"C:\TEST\MAITOK" command:"npx vitest run"
```

## Recipe 2: Parallel Multi-Agent

```bash
# Slot 1: Frontend
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent frontend-architect 'Implement infinite scroll in CommentList'"

# Slot 2: Backend (simultaneous)
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect 'GET /api/comments cursor pagination'"

# After both done → MAIBOT verify → test agent
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent quality-engineer 'Write pagination tests'"
```

> Concurrency limit: **Sonnet 2 slots verified** (tested 2026-02-24). 3+ risks rate limit.

## Recipe 3: Complex Refactoring

```bash
# Step 1: Opus design (1 only)
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model opus --dangerously-skip-permissions --agent system-architect 'Design JWT→OAuth2 migration plan'"

# Step 2: Sonnet parallel implementation based on design
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect 'Implement OAuth2 provider per design'"
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent frontend-architect 'Update login UI per design'"
```

## Recipe 4: PR Review

```bash
# Isolate with git worktree
exec command:"git -C C:\TEST\MAITOK worktree add C:\TEMP\review-pr42 pr-42-branch"
exec pty:true workdir:"C:\TEMP\review-pr42" command:"claude -p --dangerously-skip-permissions --agent code-reviewer 'Review vs origin/main. Security, performance, code quality.'"

# Cleanup
exec command:"git -C C:\TEST\MAITOK worktree remove C:\TEMP\review-pr42"
```

## Recipe 5: Parallel Issue Fix

```bash
# Create worktrees
exec command:"git -C C:\TEST\MAITOK worktree add -b fix/issue-12 C:\TEMP\issue-12 main"
exec command:"git -C C:\TEST\MAITOK worktree add -b fix/issue-15 C:\TEMP\issue-15 main"

# Parallel fix
exec pty:true background:true workdir:"C:\TEMP\issue-12" command:"claude -p --model sonnet --dangerously-skip-permissions 'Fix issue #12: [description]. Commit.'"
exec pty:true background:true workdir:"C:\TEMP\issue-15" command:"claude -p --model sonnet --dangerously-skip-permissions 'Fix issue #15: [description]. Commit.'"

# After done → open PRs
exec workdir:"C:\TEMP\issue-12" command:"git push -u origin fix/issue-12"
```
