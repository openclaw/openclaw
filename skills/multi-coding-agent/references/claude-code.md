# Claude Code CLI Reference

Detailed reference for Claude Code as a fallback when Codex is unavailable.

## Contents
- Non-interactive mode flags
- Model selection
- Permission modes
- Budget controls
- Output formats
- Examples

---

## Non-Interactive Mode (-p/--print)

The `-p` flag runs Claude in non-interactive mode: it processes the prompt and exits.

```bash
claude -p "Your prompt here"
```

**Note:** The `-p` flag skips workspace trust dialogs. Only use in trusted directories.

---

## Flags Reference

| Flag | Description |
|------|-------------|
| `-p, --print` | Non-interactive mode, print and exit |
| `--model <model>` | Model: `sonnet`, `opus`, `haiku`, or full name |
| `--permission-mode <mode>` | Permission handling (see below) |
| `--dangerously-skip-permissions` | Skip all permission checks |
| `--max-budget-usd <amount>` | Cap API spending |
| `--fallback-model <model>` | Auto-fallback if primary overloaded |
| `--output-format <format>` | Output: `text`, `json`, `stream-json` |
| `--add-dir <dirs>` | Additional directories to allow access |
| `-c, --continue` | Continue most recent conversation |
| `-r, --resume <id>` | Resume specific session |

---

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt for approval (interactive) |
| `acceptEdits` | Auto-accept file edits |
| `bypassPermissions` | Skip all permission checks |
| `dontAsk` | Don't ask, but still enforce permissions |
| `plan` | Planning mode only |

```bash
# Auto-accept edits (recommended for automation)
claude -p --permission-mode acceptEdits "Fix the bug"

# Full bypass (like Codex --yolo)
claude -p --dangerously-skip-permissions "Build the feature"
```

---

## Model Selection

```bash
# Use Opus for complex tasks
claude -p --model opus "Design the database schema"

# Use Haiku for quick/cheap tasks
claude -p --model haiku "Add a docstring"

# Use Sonnet (default, balanced)
claude -p --model sonnet "Refactor this function"

# With fallback
claude -p --model opus --fallback-model sonnet "Complex task"
```

**Models:**
- `opus` - Most capable, highest cost
- `sonnet` - Balanced (default)
- `haiku` - Fastest, lowest cost

---

## Budget Controls

```bash
# Cap spending at $5
claude -p --max-budget-usd 5 "Build a REST API"

# Combine with fallback for cost optimization
claude -p --model opus --fallback-model haiku --max-budget-usd 2 "Review this code"
```

---

## Output Formats

```bash
# Plain text (default)
claude -p "Summarize this file"

# JSON (single result)
claude -p --output-format json "List the functions in this file"

# Streaming JSON (for real-time processing)
claude -p --output-format stream-json "Analyze this codebase"
```

---

## Working Directory

```bash
# Add specific directories for file access
claude -p --add-dir ~/project --add-dir ~/shared "Refactor across both directories"
```

---

## Session Management

```bash
# Continue last conversation
claude -p -c "Follow up on the previous task"

# Resume specific session
claude -p -r session-id "Continue from here"

# List sessions
claude --list-sessions
```

---

## Examples

### Quick Code Fix
```bash
claude -p --permission-mode acceptEdits "Fix the null pointer exception in src/api.ts"
```

### Full Auto Build
```bash
claude -p --dangerously-skip-permissions "Build a REST API with CRUD endpoints for users"
```

### Code Review with Budget
```bash
claude -p --model opus --max-budget-usd 1 "Review this PR for security issues"
```

### Background Task (with PTY)
```bash
bash pty:true workdir:~/project background:true command:"claude 'Build the authentication module'"
```

---

## Codex → Claude Mapping

| Codex | Claude |
|-------|--------|
| `codex exec "prompt"` | `claude -p "prompt"` |
| `codex exec --full-auto "prompt"` | `claude -p --permission-mode acceptEdits "prompt"` |
| `codex --yolo "prompt"` | `claude -p --dangerously-skip-permissions "prompt"` |
| `codex review --base main` | `claude -p "Review changes vs main branch"` |
