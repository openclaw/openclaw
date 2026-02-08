# Gemini CLI Reference

Detailed reference for Gemini CLI as a fallback coding agent.

## Contents
- Basic usage
- Approval modes
- Model selection
- Sandbox mode
- Session management
- Output formats
- Examples

---

## Basic Usage

Gemini CLI defaults to one-shot mode with positional prompts:

```bash
gemini "Your prompt here"
```

For interactive mode, use `-i`:

```bash
gemini -i "Start with this prompt"
```

---

## Flags Reference

| Flag | Description |
|------|-------------|
| `-y, --yolo` | Auto-approve all actions |
| `--approval-mode <mode>` | Approval handling (see below) |
| `-m, --model <model>` | Select model |
| `-s, --sandbox` | Run in sandbox mode |
| `-i, --prompt-interactive` | Interactive mode with initial prompt |
| `-o, --output-format <format>` | Output: `text`, `json`, `stream-json` |
| `-r, --resume <id>` | Resume session (`latest` or index) |
| `--include-directories <dirs>` | Additional directories to include |
| `-d, --debug` | Debug mode |

---

## Approval Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt for approval |
| `auto_edit` | Auto-approve edit tools only |
| `yolo` | Auto-approve all tools |

```bash
# Auto-approve edits only
gemini --approval-mode auto_edit "Fix the bug in api.ts"

# Full auto (yolo)
gemini -y "Build the feature"
# or
gemini --approval-mode yolo "Build the feature"
```

---

## Model Selection

```bash
# Specify model
gemini -m gemini-2.5-pro "Complex analysis task"

# Default model (usually gemini-2.5-flash)
gemini "Quick task"
```

---

## Sandbox Mode

Run in a sandboxed environment for safety:

```bash
gemini -s "Experiment with this code"
gemini --sandbox "Run untrusted operations"
```

---

## Working Directories

```bash
# Include additional directories
gemini --include-directories ~/project,~/shared "Work across directories"

# Multiple flags
gemini --include-directories ~/project --include-directories ~/lib "Cross-repo task"
```

---

## Session Management

```bash
# List available sessions
gemini --list-sessions

# Resume latest session
gemini -r latest "Continue where we left off"

# Resume specific session by index
gemini -r 5 "Continue session 5"

# Delete a session
gemini --delete-session 3
```

---

## Output Formats

```bash
# Plain text (default)
gemini "Summarize this"

# JSON output
gemini -o json "List functions in this file"

# Streaming JSON
gemini -o stream-json "Analyze codebase"
```

---

## Examples

### Quick Code Fix
```bash
gemini --approval-mode auto_edit "Fix the null check in src/api.ts"
```

### Full Auto Build
```bash
gemini -y "Build a REST API with user authentication"
```

### Sandboxed Experiment
```bash
gemini -s -y "Try refactoring this module using a different pattern"
```

### Interactive Session (with PTY)
```bash
bash pty:true workdir:~/project command:"gemini -i 'Help me debug this issue'"
```

### Background Task
```bash
bash pty:true workdir:~/project background:true command:"gemini -y 'Build the feature module'"
```

---

## Codex → Gemini Mapping

| Codex | Gemini |
|-------|--------|
| `codex exec "prompt"` | `gemini "prompt"` |
| `codex exec --full-auto "prompt"` | `gemini --approval-mode auto_edit "prompt"` |
| `codex --yolo "prompt"` | `gemini -y "prompt"` |

---

## Extensions & MCP

Gemini supports extensions and MCP servers:

```bash
# List extensions
gemini -l

# Use specific extensions
gemini -e code-search,git "Find and fix the bug"

# Manage MCP servers
gemini mcp
```
