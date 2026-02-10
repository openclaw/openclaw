---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: coding-agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Coding Agent (bash-first)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **bash** (with optional background mode) for all coding agent work. Simple and effective.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ⚠️ PTY Mode Required!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Coding agents (Codex, Claude Code, Pi) are **interactive terminal applications** that need a pseudo-terminal (PTY) to work correctly. Without PTY, you'll get broken output, missing colors, or the agent may hang.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Always use `pty:true`** when running coding agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ✅ Correct - with PTY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true command:"codex exec 'Your prompt'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ❌ Wrong - no PTY, agent may break（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash command:"codex exec 'Your prompt'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bash Tool Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parameter    | Type    | Description                                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------- | --------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `command`    | string  | The shell command to run                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pty`        | boolean | **Use for coding agents!** Allocates a pseudo-terminal for interactive CLIs |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `workdir`    | string  | Working directory (agent sees only this folder's context)                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `background` | boolean | Run in background, returns sessionId for monitoring                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `timeout`    | number  | Timeout in seconds (kills process on expiry)                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `elevated`   | boolean | Run on host instead of sandbox (if allowed)                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Process Tool Actions (for background sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Action      | Description                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------- | ---------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `list`      | List all running/recent sessions                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `poll`      | Check if session is still running                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `log`       | Get session output (with optional offset/limit)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `write`     | Send raw data to stdin                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `submit`    | Send data + newline (like typing and pressing Enter) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `send-keys` | Send key tokens or hex bytes                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `paste`     | Paste text (with optional bracketed mode)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `kill`      | Terminate the session                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start: One-Shot Tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For quick prompts/chats, create a temp git repo and run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Quick chat (Codex needs a git repo!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt here"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or in a real project - with PTY!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/Projects/myproject command:"codex exec 'Add error handling to the API calls'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why git init?** Codex refuses to run outside a trusted git directory. Creating a temp repo solves this for scratch work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Pattern: workdir + background + pty（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For longer tasks, use background mode with PTY:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Start agent in target directory (with PTY!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a snake game'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Returns sessionId for tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Monitor progress（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:log sessionId:XXX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check if done（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:poll sessionId:XXX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send input (if agent asks a question)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:write sessionId:XXX data:"y"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Submit with Enter (like typing "yes" and pressing Enter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:submit sessionId:XXX data:"yes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Kill if needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:kill sessionId:XXX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Codex CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Flag            | Effect                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | -------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `exec "prompt"` | One-shot execution, exits when done                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--full-auto`   | Sandboxed but auto-approves in workspace           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--yolo`        | NO sandbox, NO approvals (fastest, most dangerous) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Building/Creating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Quick one-shot (auto-approves) - remember PTY!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build a dark mode toggle'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Background for longer work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"codex --yolo 'Refactor the auth module'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reviewing PRs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**⚠️ CRITICAL: Never review PRs in OpenClaw's own project folder!**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Clone to temp folder or use git worktree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clone to temp for safe review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
REVIEW_DIR=$(mktemp -d)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/user/repo.git $REVIEW_DIR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd $REVIEW_DIR && gh pr checkout 130（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clean up after: trash $REVIEW_DIR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or use git worktree (keeps main intact)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree add /tmp/pr-130-review pr-130-branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:/tmp/pr-130-review command:"codex review --base main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Batch PR Reviews (parallel army!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Fetch all PR refs first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Deploy the army - one Codex per PR (all with PTY!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #86. git diff origin/main...origin/pr/86'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #87. git diff origin/main...origin/pr/87'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Monitor all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Post results to GitHub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr comment <PR#> --body "<review content>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Claude Code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# With PTY for proper terminal output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project command:"claude 'Your task'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Background（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"claude 'Your task'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenCode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project command:"opencode run 'Your task'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pi Coding Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install: npm install -g @mariozechner/pi-coding-agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project command:"pi 'Your task'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Non-interactive mode (PTY still recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true command:"pi -p 'Summarize src/'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Different provider/model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parallel Issue Fixing with git worktrees（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For fixing multiple issues in parallel, use git worktrees:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1. Create worktrees for each issue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree add -b fix/issue-78 /tmp/issue-78 main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree add -b fix/issue-99 /tmp/issue-99 main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 2. Launch Codex in each (background + PTY!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99: <description>. Commit and push.'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 3. Monitor progress（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:log sessionId:XXX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 4. Create PRs after fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd /tmp/issue-78 && git push -u origin fix/issue-78（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 5. Cleanup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree remove /tmp/issue-78（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree remove /tmp/issue-99（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ⚠️ Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Always use pty:true** - coding agents need a terminal!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Respect tool choice** - if user asks for Codex, use Codex.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Orchestrator mode: do NOT hand-code patches yourself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Be patient** - don't kill sessions because they're "slow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Monitor with process:log** - check progress without interfering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **--full-auto for building** - auto-approves changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **vanilla for reviewing** - no special flags needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Parallel is OK** - run many Codex processes at once for batch work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. **NEVER start Codex in ~/clawd/** - it'll read your soul docs and get weird ideas about the org chart!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. **NEVER checkout branches in ~/Projects/openclaw/** - that's the LIVE OpenClaw instance!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Progress Updates (Critical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you spawn coding agents in the background, keep the user in the loop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send 1 short message when you start (what's running + where).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Then only update again when something changes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - a milestone completes (build finished, tests passed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - the agent asks a question / needs input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - you hit an error or need user action（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - the agent finishes (include what changed + where)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you kill a session, immediately say you killed it and why.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-Notify on Completion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For long-running background tasks, append a wake trigger to your prompt so OpenClaw gets notified immediately when the agent finishes (instead of waiting for the next heartbeat):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
... your task here.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When completely finished, run this command to notify me:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system event --text "Done: [brief summary of what was built]" --mode now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bash pty:true workdir:~/project background:true command:"codex --yolo exec 'Build a REST API for todos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When completely finished, run: openclaw system event --text \"Done: Built todos REST API with CRUD endpoints\" --mode now'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This triggers an immediate wake event — Skippy gets pinged in seconds, not 10 minutes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Learnings (Jan 2026)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **PTY is essential:** Coding agents are interactive terminal apps. Without `pty:true`, output breaks or agent hangs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **exec is your friend:** `codex exec "prompt"` runs and exits cleanly - perfect for one-shots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sass works:** Codex responds well to playful prompts. Asked it to write a haiku about being second fiddle to a space lobster, got: _"Second chair, I code / Space lobster sets the tempo / Keys glow, I follow"_ 🦞（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
