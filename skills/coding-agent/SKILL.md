---
name: coding-agent
description: 'Delegate coding tasks to Codex, Claude Code, or Pi agents via background process. Use when: (1) building/creating new features or apps, (2) reviewing PRs (spawn in temp dir), (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-liner fixes (just edit), reading code (use read tool), thread-bound ACP harness requests in chat (for example spawn/run Codex or Claude Code in a Discord thread; use sessions_spawn with runtime:"acp"), or any work in ~/clawd workspace (never spawn agents here). Claude Code: use --print --permission-mode bypassPermissions (no PTY). Codex/Pi/OpenCode: pty:true required.'
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] },
        "install":
          [
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI (npm)",
            },
            {
              "id": "node-codex",
              "kind": "node",
              "package": "@openai/codex",
              "bins": ["codex"],
              "label": "Install Codex CLI (npm)",
            },
          ],
      },
  }
---

# Coding Agent

## Agent/PTY Matrix

| Agent | PTY | Command pattern |
|-------|-----|-----------------|
| Codex | ✅ required | `codex exec "prompt"` / `codex --yolo` / `codex --full-auto` |
| Pi | ✅ required | `pi "prompt"` / `pi -p "prompt"` |
| OpenCode | ✅ required | `opencode run "prompt"` |
| Claude Code | ❌ no PTY | `claude --permission-mode bypassPermissions --print "prompt"` |

**Why no PTY for Claude Code**: `--dangerously-skip-permissions` with PTY exits after confirmation dialog. `--print` keeps full tool access without interactive prompts.

**Why git repo for Codex**: Codex refuses to run outside a trusted git dir. Use `mktemp -d && git init` for scratch work.

## Quick Start

```bash
# Codex one-shot (PTY required)
exec pty:true workdir:~/project command:"codex exec --full-auto 'Add error handling to API calls'"

# Claude Code background
exec workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Refactor auth module'"

# Scratch work (Codex needs a git repo)
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
exec pty:true workdir:$SCRATCH command:"codex exec 'Your prompt'"
```

## Background Pattern (long tasks)

```bash
# Start
exec pty:true workdir:~/project background:true command:"codex --yolo 'Build snake game'"
# → returns sessionId

# Monitor
process action:log sessionId:XXX
process action:poll sessionId:XXX

# Interact
process action:submit sessionId:XXX data:"yes"   # send input + Enter
process action:write sessionId:XXX data:"y"       # raw stdin

# Kill
process action:kill sessionId:XXX
```

## PR Review

⚠️ **Never review PRs in OpenClaw's own project folder.** Clone to temp or use worktree.

```bash
# Clone to temp
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR && cd $REVIEW_DIR && gh pr checkout 130
exec pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"

# Worktree (keeps main intact)
git worktree add /tmp/pr-130 pr-130-branch
exec pty:true workdir:/tmp/pr-130 command:"codex review --base main"
```

## Parallel Issue Fixing

```bash
# Create worktrees
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# Launch in parallel
exec pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <desc>. Commit and push.'"
exec pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99. Commit and push.'"

# Monitor, then PR
process action:list
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

## Auto-Notify on Completion

Append to any long-running prompt so OpenClaw gets pinged immediately:
```
... your task.

When completely finished, run:
openclaw system event --text "Done: [brief summary]" --mode now
```

## Codex Flags

| Flag | Effect |
|------|--------|
| `exec "prompt"` | One-shot, exits when done |
| `--full-auto` | Auto-approves changes (sandboxed) |
| `--yolo` | No sandbox, no approvals (fastest) |

**Default model**: `gpt-5.2-codex` (set in `~/.codex/config.toml`)

## Rules

1. Right execution mode per agent (see matrix above)
2. Respect tool choice — if user asks for Codex, use Codex. Don't silently take over if agent fails.
3. Be patient — don't kill slow sessions
4. `--full-auto` for building, vanilla for reviewing
5. **NEVER start Codex in `~/.openclaw/`** — it reads soul docs and gets weird ideas
6. **NEVER checkout branches in `~/Projects/openclaw/`** — live OpenClaw instance

## Progress Updates

- Send 1 message when starting (what's running, where)
- Update only on: milestone complete, agent asks question, error, agent finishes
- If you kill a session, immediately say why
