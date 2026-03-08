---
name: coding-agent
description: 'Delegate coding tasks to Codex, Claude Code, or Pi agents via background process. Use when: (1) building/creating new features or apps, (2) reviewing PRs (spawn in temp dir), (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-liner fixes (just edit), reading code (use read tool), thread-bound ACP harness requests in chat (for example spawn/run Codex or Claude Code in a Discord thread; use sessions_spawn with runtime:"acp"), or any work in ~/clawd workspace (never spawn agents here). Claude Code: use --print --permission-mode bypassPermissions (no PTY). Codex/Pi/OpenCode: pty:true required.'
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent (bash-first)

Use **bash** (with optional background mode) for all coding agent work. Simple and effective.

## ⚠️ PTY Mode: Codex/Pi/OpenCode yes, Claude Code no

For **Codex, Pi, and OpenCode**, PTY is still required (interactive terminal apps):

```bash
# ✅ Correct for Codex/Pi/OpenCode
bash pty:true command:"codex exec 'Your prompt'"
```

For **Claude Code** (`claude` CLI), use `--print --permission-mode bypassPermissions` instead.
`--dangerously-skip-permissions` with PTY can exit after the confirmation dialog.
`--print` mode keeps full tool access and avoids interactive confirmation:

```bash
# ✅ Correct for Claude Code (no PTY needed)
cd /path/to/project && claude --permission-mode bypassPermissions --print 'Your task'

# For background execution: use background:true on the exec tool

# ❌ Wrong for Claude Code
bash pty:true command:"claude --dangerously-skip-permissions 'task'"
```

### Bash Tool Parameters

| Parameter    | Type    | Description                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `command`    | string  | The shell command to run                                                    |
| `pty`        | boolean | **Use for coding agents!** Allocates a pseudo-terminal for interactive CLIs |
| `workdir`    | string  | Working directory (agent sees only this folder's context)                   |
| `background` | boolean | Run in background, returns sessionId for monitoring                         |
| `timeout`    | number  | Timeout in seconds (kills process on expiry)                                |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed)                                 |

### Process Tool Actions (for background sessions)

| Action      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `list`      | List all running/recent sessions                     |
| `poll`      | Check if session is still running                    |
| `log`       | Get session output (with optional offset/limit)      |
| `write`     | Send raw data to stdin                               |
| `submit`    | Send data + newline (like typing and pressing Enter) |
| `send-keys` | Send key tokens or hex bytes                         |
| `paste`     | Paste text (with optional bracketed mode)            |
| `kill`      | Terminate the session                                |

---

## Quick Start: One-Shot Tasks

For quick prompts/chats, create a temp git repo and run:

```bash
# Quick chat (Codex needs a git repo!)
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt here"

# Or in a real project - with PTY!
bash pty:true workdir:~/Projects/myproject command:"codex exec 'Add error handling to the API calls'"
```

**Why git init?** Codex refuses to run outside a trusted git directory. Creating a temp repo solves this for scratch work.

---

## The Pattern: workdir + background + pty

For longer tasks, use background mode with PTY:

```bash
# Start agent in target directory (with PTY!)
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a snake game'"
# Returns sessionId for tracking

# Monitor progress
process action:log sessionId:XXX

# Check if done
process action:poll sessionId:XXX

# Send input (if agent asks a question)
process action:write sessionId:XXX data:"y"

# Submit with Enter (like typing "yes" and pressing Enter)
process action:submit sessionId:XXX data:"yes"

# Kill if needed
process action:kill sessionId:XXX
```

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅).

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Flags

| Flag            | Effect                                             |
| --------------- | -------------------------------------------------- |
| `exec "prompt"` | One-shot execution, exits when done                |
| `--full-auto`   | Sandboxed but auto-approves in workspace           |
| `--yolo`        | NO sandbox, NO approvals (fastest, most dangerous) |

### Building/Creating

```bash
# Quick one-shot (auto-approves) - remember PTY!
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build a dark mode toggle'"

# Background for longer work
bash pty:true workdir:~/project background:true command:"codex --yolo 'Refactor the auth module'"
```

### Reviewing PRs

**⚠️ CRITICAL: Never review PRs in OpenClaw's own project folder!**
Clone to temp folder or use git worktree.

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"
# Clean up after: trash $REVIEW_DIR

# Or use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
bash pty:true workdir:/tmp/pr-130-review command:"codex review --base main"
```

### Batch PR Reviews (parallel army!)

```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one Codex per PR (all with PTY!)
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #86. git diff origin/main...origin/pr/86'"
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #87. git diff origin/main...origin/pr/87'"

# Monitor all
process action:list

# Post results to GitHub
gh pr comment <PR#> --body "<review content>"
```

---

## Multi-Agent Orchestration (Experimental)

Codex CLI (v0.111.0+) can spawn parallel sub-agents within a single session. Instead of one agent doing everything serially, you break the work into specialized parallel streams.

> **Status:** This feature is `experimental` and may change. Enable it explicitly before use.

### Enabling Multi-Agent

Via CLI:
```bash
codex features enable multi_agent
```

Or in `~/.codex/config.toml`:
```toml
[features]
multi_agent = true
```

Restart Codex after enabling.

### Agent Roles

Define specialized roles so agents stay in their lane. An explorer shouldn't rewrite files, and a worker shouldn't waste time mapping the codebase.

In your project's `codex.toml` or `~/.codex/config.toml`:

```toml
[agents.explorer]
model = "gpt-5.2-codex"          # fast model for scanning
sandbox_permissions = ["disk-full-read-access"]  # read-only
instructions = "Map the codebase. Gather evidence. Do not modify files."

[agents.reviewer]
model = "o3"                      # high-reasoning for correctness
sandbox_permissions = ["disk-full-read-access"]
instructions = "Review for security, correctness, and test coverage. Report risks as JSON."

[agents.worker]
model = "gpt-5.2-codex"
sandbox_permissions = ["disk-full-read-access", "disk-write-access"]
instructions = "Implement fixes. Commit after each change."
```

### CSV Batch Processing

The `spawn_agents_on_csv` tool spawns one worker sub-agent per row. Each worker must call `report_agent_job_result` exactly once. If a worker exits without reporting, that row is marked failed in the output CSV.

Tool parameters:
- `csv_path`: source CSV file
- `instruction`: worker prompt template with `{column_name}` placeholders
- `id_column`: column to use as stable item ID
- `output_schema`: JSON shape each worker must return
- `output_csv_path`: where to write combined results
- `max_concurrency`, `max_runtime_seconds`: job control

```bash
# Create a CSV with targets
cat > /tmp/components.csv << 'EOF'
path,owner
src/api/auth.ts,backend-team
src/api/payments.ts,backend-team
src/components/UserForm.tsx,frontend-team
src/lib/db.ts,backend-team
EOF

# Run Codex with a batch audit prompt
bash pty:true workdir:~/project background:true command:"codex exec --full-auto '
Call spawn_agents_on_csv with:
- csv_path: /tmp/components.csv
- id_column: path
- instruction: \"Review {path} owned by {owner}. Return JSON with keys path, risk, summary, and follow_up via report_agent_job_result.\"
- output_csv_path: /tmp/components-review.csv
- output_schema: object with required string fields path, risk, summary, follow_up
'"
```

The exported CSV includes original row data plus metadata: `job_id`, `item_id`, `status`, `last_error`, `result_json`.

Related config settings:
- `agents.max_threads`: max concurrent agent threads
- `agents.job_max_runtime_seconds`: default per-worker timeout for CSV fan-out jobs (per-call `max_runtime_seconds` overrides this)

### Mapping to OpenClaw Fleet

If you run OpenClaw with a fleet of named agents, Codex multi-agent is a different layer:

| Layer | What it does | Example |
|-------|-------------|---------|
| **OpenClaw fleet** | Routes tasks to the right agent (dev, research, deploy) | "Agent A handles code, Agent B handles research" |
| **Codex multi-agent** | Parallelizes work within a single Codex session | "3 sub-agents audit 3 files simultaneously" |

They compose well. Your OpenClaw orchestrator spawns a Codex agent for a coding task, and that Codex session internally fans out sub-agents for parallel work.

**Prerequisite:** Run `codex features enable multi_agent` once before using these patterns. The feature must be enabled before Codex can spawn sub-agents.

```bash
# OpenClaw spawns one Codex session for a big audit
# (multi_agent must already be enabled in ~/.codex/config.toml)
bash pty:true workdir:~/project background:true command:"codex exec --full-auto '
Spawn 3 parallel reviewers:
1. Explorer: map all API routes and list them
2. Reviewer: check auth middleware on each route
3. Worker: fix any missing auth guards and commit
'"
```

### Monitoring Sub-Agents

Sub-agent activity shows up in the Codex CLI output. Use `process action:log` to watch from OpenClaw, or use `/agent` in the CLI to switch between active threads:

```bash
# From OpenClaw: watch sub-agent progress
process action:log sessionId:XXX

# From interactive Codex CLI:
# /agent         - list active agent threads, switch between them
# Ask Codex to steer, stop, or close a running sub-agent directly
```

For long-running or polling workflows, Codex has a built-in `monitor` role tuned for waiting and repeated status checks. The `wait` tool supports long polling windows (up to 1 hour per call).

Currently visible only in CLI. IDE/app visibility is planned.

### Tips and Gotchas

- **Sub-agents inherit sandbox policy.** If the parent is `--full-auto`, sub-agents are sandboxed too. If `--yolo`, sub-agents get full access.
- **Start small.** Try 2-3 sub-agents before scaling to 20. Debug one workflow first.
- **CSV batches can be large** but respect `agents.max_threads`. Default concurrency is reasonable, don't crank it without testing.
- **Failed sub-agents don't crash the parent.** The row is marked failed and the batch continues.
- **Role separation matters.** A read-only explorer can't accidentally delete files. Use `sandbox_permissions` to enforce boundaries.
- **This is experimental.** The API surface may change between Codex releases. Pin your Codex version for production workflows.

---

## Claude Code

```bash
# Foreground
bash workdir:~/project command:"claude --permission-mode bypassPermissions --print 'Your task'"

# Background
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"
```

---

## OpenCode

```bash
bash pty:true workdir:~/project command:"opencode run 'Your task'"
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project command:"pi 'Your task'"

# Non-interactive mode (PTY still recommended)
bash pty:true command:"pi -p 'Summarize src/'"

# Different provider/model
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"
```

**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!

---

## Parallel Issue Fixing with git worktrees

For fixing multiple issues in parallel, use git worktrees:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Launch Codex in each (background + PTY!)
bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'"
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99 from the approved ticket summary. Implement only the in-scope edits and commit after review.'"

# 3. Monitor progress
process action:list
process action:log sessionId:XXX

# 4. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ Rules

1. **Use the right execution mode per agent**:
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions` (no PTY required)
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **NEVER start Codex in ~/.openclaw/** - it'll read your soul docs and get weird ideas about the org chart!
9. **NEVER checkout branches in ~/Projects/openclaw/** - that's the LIVE OpenClaw instance!
10. **Multi-agent: test roles before batch runs** - verify your Explorer/Reviewer/Worker configs work on a single file before unleashing a CSV batch across the whole repo
11. **Multi-agent: read-only for exploration** - always use `disk-full-read-access` (no write) for explorer/reviewer roles. Only workers should write.

---

## Progress Updates (Critical)

When you spawn coding agents in the background, keep the user in the loop.

- Send 1 short message when you start (what's running + where).
- Then only update again when something changes:
  - a milestone completes (build finished, tests passed)
  - the agent asks a question / needs input
  - you hit an error or need user action
  - the agent finishes (include what changed + where)
- If you kill a session, immediately say you killed it and why.

This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.

---

## Auto-Notify on Completion

For long-running background tasks, append a wake trigger to your prompt so OpenClaw gets notified immediately when the agent finishes (instead of waiting for the next heartbeat):

```
... your task here.

When completely finished, run this command to notify me:
openclaw system event --text "Done: [brief summary of what was built]" --mode now
```

**Example:**

```bash
bash pty:true workdir:~/project background:true command:"codex --yolo exec 'Build a REST API for todos.

When completely finished, run: openclaw system event --text \"Done: Built todos REST API with CRUD endpoints\" --mode now'"
```

This triggers an immediate wake event — Skippy gets pinged in seconds, not 10 minutes.

---

## Learnings (Jan 2026)

- **PTY is essential:** Coding agents are interactive terminal apps. Without `pty:true`, output breaks or agent hangs.
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.
- **exec is your friend:** `codex exec "prompt"` runs and exits cleanly - perfect for one-shots.
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.
- **Sass works:** Codex responds well to playful prompts. Asked it to write a haiku about being second fiddle to a space lobster, got: _"Second chair, I code / Space lobster sets the tempo / Keys glow, I follow"_ 🦞
