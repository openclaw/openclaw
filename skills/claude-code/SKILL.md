---
name: claude-code
description: "Use Claude Code CLI to build projects, features, and self-modify the OpenClaw codebase. Use when: (1) building new apps or features via Claude Code, (2) self-rebuilding or modifying OpenClaw source, (3) delegating complex multi-file coding tasks to Claude Code, (4) running Claude Code in print mode for scripted/piped workflows. NOT for: simple edits (just edit directly), reading code (use read tool), or tasks better suited to Codex/Pi (see coding-agent skill). Requires `claude` binary."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "requires": { "bins": ["claude"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@anthropic-ai/claude-code",
              "global": true,
              "bins": ["claude"],
              "label": "Install Claude Code (npm -g)",
            },
          ],
      },
  }
---

# Claude Code CLI

Binary: `/Users/vero/.local/bin/claude`
Use Claude Code to build things, fix things, and rebuild yourself.

## ⚠️ PTY Required for Interactive Mode

Claude Code is a full interactive terminal app. **Always use `pty:true`** when launching interactively:

```bash
# ✅ Correct
bash pty:true workdir:~/project command:"claude 'Your task'"

# ❌ Broken output / hangs
bash command:"claude 'Your task'"
```

Print mode (`-p`) does NOT need PTY — it writes to stdout and exits.

---

## Modes

### 1. Interactive (default)

Full TUI with tool use, file editing, and conversation. Best for complex multi-step work.

```bash
bash pty:true workdir:~/project command:"claude 'Build a REST API with auth'"
```

### 2. Print Mode (`-p`)

Non-interactive, single-shot. Outputs text to stdout and exits. Perfect for scripting, piping, and chained workflows.

```bash
# One-shot question
claude -p "Explain the auth flow in this codebase" --workdir ~/project

# Pipe output
claude -p "Generate a migration for adding user roles" | tee migration.sql

# JSON output for parsing
claude -p "List all API endpoints" --output-format json
```

### 3. Background (via openclaw bash)

For long-running builds, use background mode:

```bash
bash pty:true workdir:~/project background:true command:"claude 'Refactor the entire test suite'"

# Monitor
process action:log sessionId:XXX
process action:poll sessionId:XXX
```

---

## Key Flags

| Flag                              | Purpose                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `-p, --print`                     | Non-interactive, stdout output, exits when done               |
| `--model <model>`                 | Pick model: `sonnet`, `opus`, or full name                    |
| `--permission-mode <mode>`        | `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions` |
| `--dangerously-skip-permissions`  | Auto-approve everything (sandbox/trusted dirs only!)          |
| `--allowedTools <tools>`          | Restrict tools: `"Bash(git *) Edit Read"`                     |
| `--add-dir <dirs>`                | Grant access to additional directories                        |
| `--max-budget-usd <n>`            | Cost cap (print mode only)                                    |
| `--system-prompt <prompt>`        | Override system prompt                                        |
| `--append-system-prompt <prompt>` | Add to default system prompt                                  |
| `-c, --continue`                  | Resume most recent conversation in cwd                        |
| `-r, --resume <id>`               | Resume specific session by ID                                 |
| `-w, --worktree [name]`           | Auto-create git worktree for isolated work                    |
| `--output-format <fmt>`           | `text`, `json`, `stream-json` (print mode)                    |
| `--effort <level>`                | `low`, `medium`, `high`, `max`                                |

---

## Self-Build: Modifying OpenClaw

This is the big one. You can use Claude Code to work on your own source code.

### Safety Rules

1. **NEVER run Claude Code directly in `~/openclaw/`** — that's the live checkout. Use a worktree or clone.
2. **NEVER run with `--dangerously-skip-permissions` on the live checkout.**
3. **Always use a worktree or temp clone** so the live instance keeps running.
4. **Commit and PR** — don't merge directly to main.

### Worktree Pattern (preferred)

```bash
# Create isolated worktree from latest main
cd ~/openclaw
git fetch origin
git worktree add -b self/my-feature /tmp/openclaw-build origin/main

# Launch Claude Code in the worktree
bash pty:true workdir:/tmp/openclaw-build background:true command:"claude --permission-mode acceptEdits 'Your task description here.

When finished, commit your changes and run: openclaw system event --text \"Done: [summary]\" --mode now'"

# Monitor
process action:log sessionId:XXX

# When done: push and PR
cd /tmp/openclaw-build
git push -u origin self/my-feature
gh pr create --repo openclaw/openclaw --title "feat: ..." --body "..."

# Cleanup
cd ~/openclaw && git worktree remove /tmp/openclaw-build
```

### Temp Clone Pattern (for bigger changes)

```bash
BUILDDIR=$(mktemp -d)
git clone https://github.com/openclaw/openclaw.git $BUILDDIR
cd $BUILDDIR && git checkout -b self/big-refactor

bash pty:true workdir:$BUILDDIR background:true command:"pnpm install && claude --permission-mode acceptEdits 'Refactor the plugin system...

When finished, commit and run: openclaw system event --text \"Done: plugin refactor\" --mode now'"
```

### What You Can Self-Build

- New skills (create in `skills/<name>/SKILL.md`)
- New CLI commands (`src/cli/`)
- Gateway routes and handlers (`src/gateway/`)
- Plugin integrations (`extensions/`)
- Bug fixes anywhere in the codebase
- Test coverage improvements
- Documentation updates

### Self-Build Prompt Template

When spawning Claude Code to work on OpenClaw, include context:

```
You are working on the OpenClaw project — an AI agent framework.
Repo: https://github.com/openclaw/openclaw
This is a pnpm monorepo. Run `pnpm install` if node_modules is missing.

Task: <describe the task>

Rules:
- Read AGENTS.md at the repo root for project conventions.
- Never edit node_modules or vendored code.
- Use Conventional Commits (feat:, fix:, refactor:, etc.).
- Run `pnpm lint` before committing.
- Commit when done.

When completely finished, run:
openclaw system event --text "Done: <brief summary>" --mode now
```

---

## Building New Projects

For greenfield work unrelated to OpenClaw:

```bash
# Create project directory
mkdir -p ~/Projects/my-new-app && cd ~/Projects/my-new-app && git init

# Launch Claude Code
bash pty:true workdir:~/Projects/my-new-app background:true command:"claude --permission-mode acceptEdits 'Build a Next.js app with...

When finished, run: openclaw system event --text \"Done: built my-new-app\" --mode now'"
```

For quick throwaway builds:

```bash
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
bash pty:true workdir:$SCRATCH command:"claude 'Build a quick Python script that...'"
```

---

## Session Management

```bash
# Resume last session in a directory
bash pty:true workdir:~/project command:"claude --continue"

# Resume specific session
bash pty:true command:"claude --resume <session-id>"

# Fork a session (new ID, same history)
bash pty:true command:"claude --resume <session-id> --fork-session"

# Name sessions for easy finding
bash pty:true workdir:~/project command:"claude --name 'auth-refactor' 'Refactor auth module'"
```

---

## MCP Servers

Claude Code can connect to MCP servers for extended capabilities:

```bash
# Add an MCP server
claude mcp add my-server -- npx my-mcp-server

# Add HTTP MCP server
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# List configured servers
claude mcp list

# Use in a session with extra MCP config
bash pty:true command:"claude --mcp-config /path/to/mcp.json 'Your task'"
```

---

## Parallel Builds

Spawn multiple Claude Code instances for independent tasks:

```bash
# Parallel feature work via worktrees
git worktree add -b feat/api /tmp/oc-api origin/main
git worktree add -b feat/ui /tmp/oc-ui origin/main

bash pty:true workdir:/tmp/oc-api background:true command:"claude --permission-mode acceptEdits 'Build the new API endpoints...'"
bash pty:true workdir:/tmp/oc-ui background:true command:"claude --permission-mode acceptEdits 'Build the new dashboard UI...'"

# Monitor both
process action:list
```

---

## Print Mode Recipes

### Code Review

```bash
claude -p "Review this diff for bugs and security issues: $(git diff main...HEAD)" --workdir ~/project
```

### Generate Commit Message

```bash
claude -p "Write a conventional commit message for these changes: $(git diff --cached)" --workdir ~/project
```

### Explain Code

```bash
claude -p "Explain what this file does and how it fits into the system" < src/gateway/router.ts
```

### Structured Output

```bash
claude -p "List all TODO comments in the codebase as JSON" --output-format json --workdir ~/project
```

---

## Rules

1. **Always `pty:true`** for interactive mode
2. **Never run in `~/openclaw/` directly** for self-modification — use worktree/clone
3. **`--permission-mode acceptEdits`** is the sweet spot for automated work (auto-approves file edits but asks for shell commands)
4. **Use `--dangerously-skip-permissions` only** in throwaway/sandboxed dirs
5. **Always include the wake event** in background prompts so you get notified on completion
6. **Set `--max-budget-usd`** for unattended print-mode runs to avoid runaway costs
7. **Respect the coding-agent skill** — if user asks for Codex or Pi, use those instead
