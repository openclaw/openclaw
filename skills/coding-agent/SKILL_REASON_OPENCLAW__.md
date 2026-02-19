# OPENCLAW Coding-Agent Skill — Comprehensive Technical Analysis

## Project Overview

This document provides a complete technical analysis of the **Coding-Agent Skill** located at `/home/openclaw/skills/coding-agent/SKILL.md`. 

The Coding-Agent skill is a **framework for delegating iterative coding tasks** to background agents (Codex, Claude Code, Pi, OpenCode) via an orchestrated bash-based interface.

**Core Purpose:** Enable OpenClaw (an AI orchestrator) to spawn, monitor, and coordinate multiple coding agents working in parallel on different tasks while maintaining safety guardrails and providing progress visibility.

**Architecture Pattern:** Orchestrator pattern using background process management with PTY (pseudo-terminal) allocation for interactive CLI agents.

---

## Skill Overview

### Metadata

| Field | Value | Description |
|-------|-------|-------------|
| **Name** | `coding-agent` | Skill identifier in OpenClaw ecosystem |
| **Emoji** | 🧩 | Visual indicator in UI |
| **Type** | Orchestration Skill | Coordinates external agents |
| **Requirements** | bash tool with `pty:true` | Needs PTY for interactive agents |
| **Bin Dependencies** | claude, codex, opencode, pi | Requires at least one agent binary |

### Skill Description (Extended)

```
Delegate coding tasks to Codex, Claude Code, or Pi agents via background 
process. Use when:
  (1) building/creating new features or apps
  (2) reviewing PRs (spawn in temp dir)
  (3) refactoring large codebases
  (4) iterative coding that needs file exploration

NOT for:
  - simple one-liner fixes (just edit)
  - reading code (use read tool)
  - any work in ~/clawd workspace (never spawn agents here)

Requires a bash tool that supports pty:true
```

---

## Architecture & Design Patterns

### System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    OpenClaw Orchestrator                     │
│                  (Main Agent/LLM Control)                    │
└─────────────────────────────┬────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ┌─────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
    │ Bash Tool  │    │ Bash Tool   │    │  Bash Tool  │
    │ (pty:true) │    │ (pty:true)  │    │ (pty:true)  │
    │            │    │             │    │             │
    │ workdir:   │    │ workdir:    │    │ workdir:    │
    │ ~/proj1    │    │ ~/proj2     │    │ /tmp/review │
    └─────┬──────┘    └──────┬──────┘    └──────┬──────┘
          │                   │                   │
    ┌─────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
    │   Codex    │    │ Claude Code │    │      Pi     │
    │   Agent    │    │    Agent    │    │    Agent    │
    │  (interactive) │    │  (interactive) │    │  (interactive) │
    │   Terminal   │    │   Terminal    │    │   Terminal    │
    └─────┬──────┘    └──────┬──────┘    └──────┬──────┘
          │                   │                   │
          │  Edits files     │  Creates code   │  Reviews PR
          │  Runs tests      │  Runs tools     │  Suggests fixes
          │  Commits code    │  Writes docs    │  Tests changes
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
          ┌───────────────────▼───────────────────┐
          │     Process Manager (monitoring)      │
          │  • list (sessions)                    │
          │  • poll (status)                      │
          │  • log (output)                       │
          │  • write/submit (input)               │
          │  • kill (terminate)                   │
          └───────────────────────────────────────┘
```

### Core Design Principles

| Principle | Implementation | Benefit |
|-----------|---|---|
| **PTY-First** | Always use `pty:true` for agents | Interactive terminal support, proper color output, cursor control |
| **Background Orchestration** | `background:true` returns sessionId | Non-blocking, fire-and-forget agent spawning |
| **Workdir Isolation** | Each agent runs in focused directory | Prevents file context pollution, keeps agents focused |
| **Git Repository Required** | Codex enforces git trust boundary | Security: agents can't run outside trusted repos |
| **Process Monitoring** | Separate process tool for tracking | Real-time visibility without interfering with agent |
| **Parallel Execution** | Multiple agents per task | Batch PR reviews, parallel issue fixing |
| **Safe Defaults** | `--full-auto` for building, vanilla for reviewing | Auto-approves in safe contexts, manual for risky ops |
| **User Notification** | Progress updates at milestones only | Prevents notification spam, keeps user informed |

---

## Core Concepts & Terminology

### 1. PTY (Pseudo-Terminal)

**What is it?**
A pseudo-terminal is a virtual terminal interface that emulates hardware terminal behavior.

**Why required for coding agents?**
- Agents are **interactive CLI applications** (like bash, vim, less)
- PTY provides:
  - Proper terminal escape sequences (for colors, cursor movement)
  - Signal handling (Ctrl+C, Ctrl+Z)
  - Line buffering matching human terminal behavior
  - Window size signals

**Without PTY (`pty:false` or missing):**
```
❌ Broken ANSI colors
❌ Missing cursor control
❌ Malformed output
❌ Agent may hang or crash
❌ Can't send Ctrl+C signals
```

**With PTY (`pty:true`):**
```
✅ Colors display correctly
✅ Terminal features work
✅ Output properly formatted
✅ Can send interrupt signals
✅ Agent behaves like interactive terminal
```

### 2. Background Mode

**What is it?**
Spawning a process that runs asynchronously (doesn't block caller).

**Parameters:**
```bash
bash pty:true workdir:~/project background:true command:"codex exec 'Build app'"
# Returns immediately with sessionId: "bg_12345abcde"
```

**Why use it?**
- Long-running tasks don't block OpenClaw
- Can spawn multiple parallel agents
- Monitor progress independently
- Allows user to do other things while coding

**Related: Session Management**

Each background session has:
- `sessionId`: Unique identifier (e.g., `bg_12345`)
- `status`: running, completed, failed, killed
- `output`: Accumulated stdout/stderr
- `pid`: Process ID (for OS-level management)

### 3. Workdir (Working Directory)

**What is it?**
The directory where the agent starts and operates.

**Why important?**
- Limits file context (agent doesn't wander off reading unrelated files)
- Provides code scope (agent knows what project to work on)
- Prevents accidents (can't accidentally edit root directory)
- Sets cwd for shell commands

**Example scenarios:**
```bash
# Build todo API - agent sees only ~/project/
workdir:~/project command:"codex exec 'Build REST API'"

# Review PR in safe temp location - agent can't touch original
workdir:/tmp/pr-130-review command:"codex review --base main"

# Fix issue in isolated worktree - main branch untouched
workdir:/tmp/issue-78 command:"codex --yolo 'Fix issue #78'"
```

### 4. Agent Binaries

| Binary | Model | Purpose | Notes |
|--------|-------|---------|-------|
| **codex** | gpt-5.2-codex (default) | General-purpose code generation | Config in ~/.codex/config.toml |
| **claude** | claude-3-opus (default) | Code + reasoning | Anthropic model |
| **opencode** | Custom OpenCode model | Build/refactor | Specialized for OpenClaw |
| **pi** | Multiple providers | Code agent framework | npm -g @mariozechner/pi-coding-agent |

### 5. Safety Levels

**Codex Flags:**

| Flag | Sandbox | Auto-Approve | Risk | Use Case |
|------|---------|--------------|------|----------|
| `exec` | Yes | Manual | Low | One-shot tasks, safe work |
| `exec --full-auto` | Yes | Auto | Medium | Building new features, auto-approve enabled |
| `--yolo` | None | Auto | High | Dangerous ops, use only in isolated worktrees |

**Safety Rules:**
1. ✅ `--full-auto` for building features in isolated project dirs
2. ✅ `--yolo` only in `/tmp/` worktrees
3. ❌ Never use `--yolo` in production directories
4. ❌ Never run in `~/clawd/` (OpenClaw's own directory)

---

## Bash Tool Interface

### Tool Parameters

**Complete Parameter Reference:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | N/A | Shell command to execute |
| `pty` | boolean | No | false | Allocate pseudo-terminal (CRITICAL for agents!) |
| `workdir` | string | No | $PWD | Working directory for command execution |
| `background` | boolean | No | false | Run asynchronously, return sessionId |
| `timeout` | number | No | 3600 | Timeout in seconds (kills process on expiry) |
| `elevated` | boolean | No | false | Run on host instead of sandbox (if allowed) |

### Usage Patterns

**Pattern 1: Quick One-Shot (foreground)**

```bash
bash pty:true command:"codex exec 'Your prompt'"
```

Execution Flow:
1. Spawn Codex with PTY
2. Run to completion
3. Return output
4. Exit (blocking)

Typical Duration: Seconds to minutes

**Pattern 2: Long Task (background)**

```bash
bash pty:true workdir:~/project background:true command:"codex --full-auto 'Build feature X'"
# Returns: sessionId_12345abcde
```

Execution Flow:
1. Spawn Codex with PTY in background
2. Return sessionId immediately (non-blocking)
3. Agent continues running
4. User can monitor with `process action:log sessionId:XXX`

Typical Duration: Minutes to hours

**Pattern 3: With Input Interaction**

```bash
# Start background session
bash pty:true background:true command:"codex exec 'Build app'"
# → Returns sessionId: bg_xyz

# Later, agent asks: "Proceed? (y/n)"
process action:submit sessionId:bg_xyz data:"yes"

# Check output
process action:log sessionId:bg_xyz
```

---

## Process Tool Reference

**Purpose:** Manage background coding agent sessions (monitor, interact, terminate).

### Process Tool Actions

| Action | Description | Use Case |
|--------|-------------|----------|
| `list` | List all running/recent sessions | "What's currently running?" |
| `poll` | Check if session is running | "Is agent still working?" |
| `log` | Get session output (with offset/limit) | "Show me the last 50 lines" |
| `write` | Send raw bytes to stdin | Send binary data without newline |
| `submit` | Send data + newline (like typing + Enter) | Answer interactive prompts |
| `send-keys` | Send key tokens or hex bytes | Send special keys (Ctrl+C, etc.) |
| `paste` | Paste text (with optional bracketed mode) | Paste multi-line content |
| `kill` | Terminate the session | "Stop this agent now" |

### Action Examples

**Monitor Running Sessions**

```bash
# List all background sessions
process action:list
# Output:
# sessionId              Status      Command                        Started
# bg_abc123             running     codex exec 'Build API'         2:14 PM
# bg_def456             completed   codex review --base main       1:45 PM
# bg_ghi789             running     claude 'Refactor module'       2:08 PM

# Check if specific session is still running
process action:poll sessionId:bg_abc123
# Output: { running: true, elapsed: 12m 34s }

# Get output with pagination
process action:log sessionId:bg_abc123 offset:0 limit:50
# Output: [first 50 lines of output]

# Get last 20 lines
process action:log sessionId:bg_abc123 offset:-20
```

**Interact with Running Agent**

```bash
# Agent asks: "Commit and push? (y/n)"
process action:submit sessionId:bg_abc123 data:"yes"

# Send raw input (e.g., password)
process action:write sessionId:bg_abc123 data:"secret_password"

# Send Ctrl+C (interrupt)
process action:send-keys sessionId:bg_abc123 data:"03"

# Paste multi-line code
process action:paste sessionId:bg_abc123 data:"def hello():\n    print('hi')"

# Terminate immediately
process action:kill sessionId:bg_abc123
# Output: { killed: true, signal: "SIGTERM" }
```

---

## Coding Agents

### 1. Codex Agent

**Model:** `gpt-5.2-codex` (set in `~/.codex/config.toml`)

**Purpose:** General-purpose code generation, building, refactoring

**Key Strengths:**
- Fast iteration on features
- Good at full-file refactoring
- Understands project structure quickly
- Can run tests and fix based on output

**Typical Workflow:**

```bash
# One-shot build
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build dark mode toggle'"

# Auto-fixes enabled (safer)
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Add logging to API calls'"

# Dangerous mode (no sandbox, use only in /tmp/)
bash pty:true workdir:/tmp/isolated background:true command:"codex --yolo 'Implement new auth system'"
```

**Flags:**

| Flag | Behavior | Use |
|------|----------|-----|
| `exec "prompt"` | One-shot, exits when done | Quick tasks |
| `exec --full-auto` | Auto-approves in workspace | Building features |
| `--yolo` | NO sandbox, NO approvals | Dangerous ops in temp dirs |

**Configuration:**

```toml
# ~/.codex/config.toml
[default]
model = "gpt-5.2-codex"
api_key = "sk-..."
timeout = 3600  # 1 hour
```

### 2. Claude Code Agent

**Model:** claude-3-opus (Anthropic)

**Purpose:** Code generation with reasoning, complex refactoring

**Usage:**

```bash
bash pty:true workdir:~/project command:"claude 'Your task'"
bash pty:true workdir:~/project background:true command:"claude 'Your task'"
```

**vs. Codex:**
- Claude: Better reasoning, verbose explanations
- Codex: Faster iteration, better at building features
- Recommendation: Use Claude for complex refactoring, Codex for building

### 3. Pi Coding Agent

**Model:** Multiple provider support (OpenAI, Anthropic, etc.)

**Installation:**

```bash
npm install -g @mariozechner/pi-coding-agent
```

**Usage:**

```bash
# Default provider/model
bash pty:true workdir:~/project command:"pi 'Your task'"

# Specific provider
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"

# With Anthropic prompt caching (Jan 2026+)
bash pty:true command:"pi --provider anthropic --model claude-3-opus -p 'Analyze src/'"
```

**Features:**
- Supports multiple LLM providers
- Prompt caching for efficiency (Anthropic)
- Code summarization with `-p` flag
- Smaller models (gpt-4o-mini) for cost-efficiency

### 4. OpenCode Agent

**Purpose:** OpenClaw-specific code agent

**Usage:**

```bash
bash pty:true workdir:~/project command:"opencode run 'Your task'"
```

---

## Use Case Patterns

### Pattern 1: Build New Feature (Safe, Auto-Approve)

**Scenario:** Build a dark mode toggle in a React app

**Design:**
- Isolated project directory (not prod)
- Auto-approve enabled (safe)
- Background mode (long-running)

**Code:**

```bash
bash pty:true workdir:~/projects/myapp background:true command:"codex exec --full-auto 'Build a dark mode toggle with localStorage persistence'"

# Monitor
process action:list
process action:log sessionId:bg_xxx

# If agent asks for input
process action:submit sessionId:bg_xxx data:"yes"
```

**Expected Output:**
- Modified CSS files (light/dark themes)
- React component updates
- Tests passing
- Commit created

### Pattern 2: Review Pull Request (Temp Dir, Vanilla)

**Scenario:** Review PR #130 without modifying the main repo

**Design:**
- Clone to temp directory
- Checkout PR branch
- No auto-approve (manual review)

**Code:**

```bash
# Setup
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && git fetch origin
git checkout origin/pr/130

# Start review (no --full-auto, requires manual approval)
bash pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"

# Monitor output
process action:log sessionId:...

# Post results
gh pr comment 130 --body "Review: [results from agent]"

# Cleanup
rm -rf $REVIEW_DIR
```

**Expected Output:**
- Line-by-line code review
- Suggestions for improvements
- Testing recommendations
- Security checks

### Pattern 3: Parallel Issue Fixing (Git Worktrees)

**Scenario:** Fix 3 issues in parallel using git worktrees

**Design:**
- Create isolated worktrees for each issue
- Spawn Codex in each (background, PTY)
- Monitor all in parallel
- Create PRs from completed worktrees

**Code:**

```bash
# 1. Create worktrees
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main
git worktree add -b fix/issue-105 /tmp/issue-105 main

# 2. Spawn agents (background + PTY + auto-approve)
SESSION_78=$(bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: Null pointer on login. Implement null checks and add tests. Commit when done.'")
SESSION_99=$(bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99: API timeout. Implement exponential backoff retry. Commit when done.'")
SESSION_105=$(bash pty:true workdir:/tmp/issue-105 background:true command:"pnpm install && codex --yolo 'Fix issue #105: Memory leak on page navigation. Review cleanup code. Commit when done.'")

# 3. Monitor all
process action:list
# Watch for completion

# 4. Create PRs
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: Null pointer on login" --body "Fixes #78"

cd /tmp/issue-99 && git push -u origin fix/issue-99
gh pr create --repo user/repo --head fix/issue-99 --title "fix: API timeout with exponential backoff" --body "Fixes #99"

cd /tmp/issue-105 && git push -u origin fix/issue-105
gh pr create --repo user/repo --head fix/issue-105 --title "fix: Memory leak on navigation" --body "Fixes #105"

# 5. Cleanup worktrees
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
git worktree remove /tmp/issue-105
```

**Timeline:**
```
T=0:00   → Spawn 3 agents in parallel
T=0:05   → All agents start coding
T=15:30  → Issue #78 completes
T=22:45  → Issue #99 completes
T=35:20  → Issue #105 completes
T=36:00  → All PRs created, worktrees cleaned
```

**Parallelism Benefit:**
- Sequential: 15 + 23 + 35 = 73 minutes
- Parallel: 35 minutes (52% time saved!)

### Pattern 4: Refactor Large Codebase (Interactive)

**Scenario:** Refactor authentication module (50+ files)

**Design:**
- Run in project directory
- Background mode (can take hours)
- Monitor progress, intervene if needed

**Code:**

```bash
# Start refactor
bash pty:true workdir:~/project background:true command:"claude exec 'Refactor the auth module to use modern async/await patterns. Review all files in src/auth/. Add tests. Update docs.'"

# Monitor progress (check every 5 minutes)
for i in {1..12}; do
  sleep 300  # 5 minutes
  process action:log sessionId:bg_xxx offset:-30
done

# If agent gets stuck, send input
process action:submit sessionId:bg_xxx data:"Let me handle this file, continue with the others"

# Kill if needed
process action:kill sessionId:bg_xxx
```

**User Updates Only at Milestones:**
- "Refactoring started (50 files identified)"
- "Auth module tests passing (15/15)"
- "API module refactored, 8 files remaining"
- "Refactoring complete, all tests passing"

**NOT:**
- "Agent is processing line 342" (too chatty)
- Every single agent message (noise)

---

## Safety Rules & Constraints

### Absolute Rules (Never Break)

1. ✅ **Always use `pty:true`**
   - Coding agents are interactive CLIs
   - Without PTY: broken output or hanging agent

2. ❌ **NEVER run agents in `~/clawd/` or OpenClaw's own directory**
   - Codex reads project files for context
   - Could accidentally modify OpenClaw itself
   - Use temp directories for testing OpenClaw code

3. ❌ **NEVER checkout branches in `~/Projects/openclaw/`**
   - That's the LIVE OpenClaw instance
   - Use git worktrees in `/tmp/` instead

4. ✅ **Git repo required for Codex**
   - Codex refuses to run outside git directories (security)
   - For scratch work: `mktemp -d && git init`

### Guideline Rules (Usually)

| Rule | Reason |
|------|--------|
| Use `--full-auto` for building | Safe when building in isolated project dirs |
| Use `--yolo` only in `/tmp/` | Most dangerous flag, keep isolated |
| Use `exec` for one-shots | Quick tasks, exit on completion |
| Use `background:true` for long tasks | Don't block orchestrator |
| Use `workdir` to limit context | Keeps agent focused, prevents accidents |
| Respect user's agent choice | If they ask for Codex, don't use Claude |
| Be patient with slow agents | Don't kill just because it's taking time |
| Monitor with `process:log` | Check progress without interfering |
| Only update user at milestones | Prevent notification spam |

### Dangerous Patterns (Avoid)

```bash
# ❌ Running in home directory (unbounded context)
bash pty:true workdir:~/ command:"codex exec 'Build something'"

# ❌ Running --yolo in a real directory
bash pty:true workdir:~/production-app background:true command:"codex --yolo 'Refactor'"

# ❌ No PTY (agent will break)
bash command:"codex exec 'Build app'"

# ❌ Running Codex in OpenClaw's own directory
bash pty:true workdir:~/clawd command:"codex exec 'Optimize OpenClaw'"

# ❌ Running in temp dir without git init
bash pty:true workdir:/tmp/scratch command:"codex exec 'Test code'"

# ❌ Silently taking over if agent fails
# (should respawn or ask user, not hand-code patches)
if agent_failed:
    do_manual_fixes()  # ❌ WRONG

# Instead:
if agent_failed:
    respawn_agent()  # or ask_user_for_direction()
```

---

## Progress Communication Strategy

### When to Update User

**DO update when:**
- ✅ Spawning a new agent (what's running + where)
- ✅ A milestone completes (build finished, tests passed)
- ✅ Agent asks for input (needs human decision)
- ✅ Unexpected error (can't continue, needs help)
- ✅ Agent finishes (what was built + where to find it)

**DON'T update when:**
- ❌ Agent is "thinking" (too chatty)
- ❌ Every line of agent output (noise)
- ❌ Every sub-task (too granular)
- ❌ Checking status if nothing changed

### Update Format

**Short, actionable messages:**

```
🧩 Starting Codex in ~/project to build dark mode toggle...
[Agent runs for 8 minutes]
✅ Feature built! Commit: f7a8c9d
Toggle component: src/components/DarkModeToggle.jsx
Styles: src/styles/dark-mode.css
All tests passing (12/12)
```

**NOT:**

```
Agent is processing file 1 of 15
Agent is processing file 2 of 15
Agent is processing file 3 of 15
...
```

---

## Common Patterns & Best Practices

### Pattern 1: Auto-Notify on Completion

**Problem:** Long tasks finish, but user doesn't know

**Solution:** Add wake trigger to prompt

```bash
bash pty:true workdir:~/project background:true command:"codex --full-auto exec 'Build REST API for todos with CRUD endpoints. When completely finished, run: openclaw system event --text \"Done: Built todos REST API\" --mode now'"
```

**Effect:**
- Agent finishes → runs `openclaw system event`
- OpenClaw gets immediate notification
- User gets pinged in seconds (not 10 minutes)

### Pattern 2: Scratch Work with Git Init

**Problem:** Codex won't run outside git repo

**Solution:** Create temp git repo

```bash
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
bash pty:true workdir:$SCRATCH command:"codex exec 'Write a simple HTTP server in Python'"
```

**Result:**
- Temp directory with git repo
- Codex can run safely
- Isolated from main projects

### Pattern 3: Clone to Temp for Reviews

**Problem:** Don't want to modify original repo during review

**Solution:** Clone to temp + checkout PR

```bash
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && git fetch origin
git checkout origin/pr/130

bash pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"

# Cleanup
rm -rf $REVIEW_DIR
```

**Safety:**
- Original repo untouched
- PR checked out in isolation
- Easy to discard after review

### Pattern 4: Batch Parallel Reviews

**Problem:** Need to review 5 PRs, doing sequentially is slow

**Solution:** Deploy agent army

```bash
# Fetch all PR refs
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Spawn agents in parallel
for PR in 86 87 88 89 90; do
  bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #$PR. git diff origin/main...origin/pr/$PR. Provide detailed feedback.'"
done

# Monitor
process action:list

# Results will come in as agents finish
```

**Timeline:**
- Sequential: 5 × 20 min = 100 minutes
- Parallel: 20 minutes (80% time saved!)

---

## Configuration & Setup

### System Requirements

```bash
# Must have bash tool with PTY support
which bash  # ✅ Should exist

# Must have at least one agent binary
which codex    # ✅ OR
which claude   # ✅ OR
which pi       # ✅ OR
which opencode # ✅

# For git operations (if using Codex)
which git      # ✅ Required

# For PR operations
which gh       # Optional but recommended
```

### Codex Setup

```bash
# Install codex
npm install -g codex

# Configure
mkdir -p ~/.codex
cat > ~/.codex/config.toml << 'EOF'
[default]
model = "gpt-5.2-codex"
api_key = "sk-..."
temperature = 0.7
timeout = 3600
EOF

# Verify
codex --version
```

### Pi Agent Setup

```bash
# Install Pi
npm install -g @mariozechner/pi-coding-agent

# Test
pi -p "Summarize this file: README.md"
```

### OpenCode Setup

```bash
# Check if available
which opencode

# Configure environment variables
export OPENCODE_API_KEY="..."
```

---

## Troubleshooting

### Agent Hangs/Doesn't Output

**Problem:** Agent starts but no output appears

**Likely Cause:** Missing `pty:true`

**Solution:**

```bash
# ❌ Wrong
bash command:"codex exec 'Build app'"

# ✅ Correct
bash pty:true command:"codex exec 'Build app'"
```

### "Codex won't run" Error

**Problem:** Codex refuses to execute

**Likely Causes:**
1. Not in git directory
2. Git security policy (repo not trusted)

**Solutions:**

```bash
# Option 1: Initialize git
cd ~/project && git init && git add -A && git commit -m "init"

# Option 2: Temp git repo for scratch
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
bash pty:true workdir:$SCRATCH command:"codex exec 'Your task'"
```

### Agent Output Cut Off

**Problem:** Session output is truncated

**Solution:** Use offset/limit with log

```bash
# Get last 100 lines
process action:log sessionId:bg_xxx offset:-100

# Get lines 500-600
process action:log sessionId:bg_xxx offset:500 limit:100
```

### Agent Killed Unexpectedly

**Problem:** Session terminated without warning

**Likely Causes:**
1. Timeout reached (default 3600 seconds)
2. Out of memory
3. User killed manually

**Solution:** Check logs

```bash
process action:log sessionId:bg_xxx offset:-50
# Look for error messages or "Killed" signal
```

**Prevention:**

```bash
# Increase timeout for long tasks
bash pty:true timeout:7200 command:"codex --full-auto exec 'Long refactor'"
```

---

## Advanced Patterns

### Pattern: Dynamic Agent Selection

**Choose agent based on task:**

```bash
if task_type == "build_feature":
    agent = "codex"  # Fast iteration
elif task_type == "complex_refactor":
    agent = "claude"  # Better reasoning
elif task_type == "cost_sensitive":
    agent = "pi --model gpt-4o-mini"  # Cheaper
else:
    agent = "opencode"  # OpenClaw-specific
```

### Pattern: Fallback Agent

**If primary agent fails, try secondary:**

```bash
# Start primary
session = bash pty:true background:true command:"codex exec 'Build API'"

# Monitor
if process.poll(session).status == "failed":
    # Fallback to Claude
    session = bash pty:true background:true command:"claude 'Build API'"
```

### Pattern: Agent Chaining

**Use output from one agent as input to next:**

```bash
# Agent 1: Write code
session1 = bash pty:true background:true command:"codex exec 'Write API endpoint'"

# Wait for completion
wait_for(session1)

# Get output
output1 = process.log(session1)

# Agent 2: Write tests for output
session2 = bash pty:true background:true command:"codex exec 'Write tests for: $output1'"
```

---

## Performance Considerations

### Parallel Agent Capacity

**How many agents can run in parallel?**

Depends on:
- Machine resources (CPU, memory, disk I/O)
- Agent complexity (simple edit vs full refactor)
- Network bandwidth (if pulling dependencies)

**Typical Safe Limits:**
- 1-2 agents: Any machine
- 3-5 agents: 8GB RAM, 4-core CPU
- 5+ agents: 16GB+ RAM, 8-core CPU with SSD

**Monitor with:**
```bash
top -b -n 1 | grep codex
ps aux | grep codex | wc -l
```

### Cost Optimization

**Use cheaper models when possible:**

```bash
# Full model (expensive, best quality)
bash command:"pi --provider openai --model gpt-4o -p 'Complex refactor'"

# Mini model (cheaper, good quality)
bash command:"pi --provider openai --model gpt-4o-mini -p 'Add logging'"

# Ultra cheap (basic tasks)
bash command:"pi --provider openai --model gpt-3.5-turbo -p 'Fix typo'"
```

### Time Optimization

**Parallel vs Sequential:**

```bash
# Sequential: 3 tasks × 15 min each = 45 min
task1 && task2 && task3

# Parallel: max(15, 15, 15) = 15 min (67% faster!)
task1 & task2 & task3 & wait
```

---

## Security Considerations

### Secrets & API Keys

**Never pass directly in commands:**

```bash
# ❌ WRONG - API key visible in process list
bash command:"codex exec 'Deploy with API_KEY=sk-1234567'"

# ✅ Correct - Use environment variables
export DEPLOYMENT_TOKEN="sk-..."
bash command:"codex exec 'Deploy' "
```

### File Permissions

**Ensure agent can't escape working directory:**

```bash
# ✅ Safe - limited to project dir
bash workdir:~/projects/safe command:"codex exec 'Build'"

# ❌ Risky - agent sees home directory
bash workdir:~/ command:"codex exec 'Build'"
```

### Git Trust

**Only run Codex in trusted repositories:**

```bash
# ✅ Trust your own project
cd ~/myproject && bash pty:true command:"codex exec 'Build'"

# ❌ Don't run in untrusted clones
cd /tmp/untrusted-clone && bash pty:true command:"codex exec 'Build'"
```

---

## Integration with OpenClaw

### Auto-Notification Pattern

**Keep user informed without interrupting:**

```bash
bash pty:true background:true command:"codex --full-auto exec 'Build dark mode toggle. When done, run: openclaw system event --text \"Dark mode ready to test\" --mode now'"
```

**OpenClaw receives event immediately upon completion.**

### Session State Management

**Track sessions across orchestrator calls:**

```bash
# Start multiple agents
sessions = {
    "api": bash pty:true background:true command:"codex exec 'Build API'",
    "ui": bash pty:true background:true command:"codex exec 'Build UI'",
    "tests": bash pty:true background:true command:"codex exec 'Write tests'"
}

# Monitor all
for task, sessionId in sessions:
    if process.poll(sessionId).status == "completed":
        print(f"✅ {task} complete")
    else:
        print(f"🔄 {task} in progress...")
```

---

## Quick Reference

### One-Liners

**Quick build:**
```bash
bash pty:true command:"codex exec 'Build <feature>'"
```

**Background build:**
```bash
bash pty:true background:true command:"codex --full-auto exec 'Build <feature>'"
```

**Review PR:**
```bash
bash pty:true workdir:/tmp/pr command:"codex review --base main"
```

**Parallel fixes:**
```bash
for issue in 78 99 105; do
  bash pty:true workdir:/tmp/issue-$issue background:true command:"codex --yolo 'Fix issue #$issue'"
done
```

**Monitor sessions:**
```bash
process action:list
process action:log sessionId:XXX
process action:kill sessionId:XXX
```

---

## Summary

The **Coding-Agent Skill** provides a comprehensive framework for:

1. **Orchestrating multiple coding agents** (Codex, Claude Code, Pi, OpenCode)
2. **Running tasks in parallel** (batch PR reviews, parallel issue fixing)
3. **Maintaining safety guardrails** (git trust, workdir isolation, sandbox modes)
4. **Monitoring progress** (background sessions, process tool)
5. **Interactive control** (submit input, send signals, terminate)

**Key Principles:**
- ✅ Always use `pty:true` for agents
- ✅ Use `background:true` for long tasks
- ✅ Limit context with `workdir`
- ✅ Monitor with `process` tool (don't interfere)
- ✅ Update user only at milestones
- ✅ Never run in `~/clawd/` or production
- ✅ Use git worktrees for parallel work

**Performance Benefits:**
- Sequential: 3 × 20 min = 60 minutes
- Parallel: 20 minutes (67% time saved)

**Security:**
- Git-enforced trust boundaries
- Workdir isolation
- Sandbox modes (--full-auto, --yolo)
- No direct access to secrets

---

*Document created: 2026-02-19*  
*Format: Comprehensive technical reference with patterns, workflows, and best practices*  
*Reference Architecture: OpenClaw orchestrator → bash tool → coding agents (Codex/Claude/Pi/OpenCode)*
