---
name: cursor-agent
version: 2.1.0
description: A comprehensive skill for using the Cursor CLI agent for various software engineering tasks (updated for 2026 features, includes tmux automation guide).
author: Pushpinder Pal Singh
---

# Cursor CLI Agent Skill

This skill provides a comprehensive guide and set of workflows for utilizing the Cursor CLI tool, including all features from the January 2026 update.

## Installation

### Standard Installation (macOS, Linux, Windows WSL)

```bash
curl https://cursor.com/install -fsS | bash
```

### Homebrew (macOS only)

```bash
brew install --cask cursor-cli
```

### Post-Installation Setup

**macOS:**
- Add to PATH in `~/.zshrc` (zsh) or `~/.bashrc` (bash):
  ```bash
  export PATH="$HOME/.local/bin:$PATH"
  ```
- Restart terminal or run `source ~/.zshrc` (or `~/.bashrc`)
- Requires macOS 10.15 or later
- Works on both Intel and Apple Silicon Macs

**Linux/Ubuntu:**
- Restart your terminal or source your shell config
- Verify with `agent --version`

**Both platforms:**
- Commands: `agent` (primary) and `cursor-agent` (backward compatible)
- Verify installation: `agent --version` or `cursor-agent --version`

## Authentication

Authenticate via browser:

```bash
agent login
```

Or use API key:

```bash
export CURSOR_API_KEY=your_api_key_here
```

## Update

Keep your CLI up to date:

```bash
agent update
# or
agent upgrade
```

## Commands

### Interactive Mode

Start an interactive session with the agent:

```bash
agent
```

Start with an initial prompt:

```bash
agent "Add error handling to this API"
```

**Backward compatibility:** `cursor-agent` still works but `agent` is now the primary command.

### Model Switching

List all available models:

```bash
agent models
# or
agent --list-models
```

Use a specific model:

```bash
agent --model gpt-5
```

Switch models during a session:

```
/models
```

### Session Management

Manage your agent sessions:

- **List sessions:** `agent ls`
- **Resume most recent:** `agent resume`
- **Resume specific session:** `agent --resume="[chat-id]"`

### Context Selection

Include specific files or folders in the conversation:

```
@filename.ts
@src/components/
```

### Slash Commands

Available during interactive sessions:

- **`/models`** - Switch between AI models interactively
- **`/compress`** - Summarize conversation and free up context window
- **`/rules`** - Create and edit rules directly from CLI
- **`/commands`** - Create and modify custom commands
- **`/mcp enable [server-name]`** - Enable an MCP server
- **`/mcp disable [server-name]`** - Disable an MCP server

### Keyboard Shortcuts

- **`Shift+Enter`** - Add newlines for multi-line prompts
- **`Ctrl+D`** - Exit CLI (requires double-press for safety)
- **`Ctrl+R`** - Review changes (press `i` for instructions, navigate with arrow keys)
- **`ArrowUp`** - Cycle through previous messages

### Non-interactive / CI Mode

Run the agent in a non-interactive mode, suitable for CI/CD pipelines:

```bash
agent -p 'Run tests and report coverage'
# or
agent --print 'Refactor this file to use async/await'
```

**Output formats:**

```bash
# Plain text (default)
agent -p 'Analyze code' --output-format text

# Structured JSON
agent -p 'Find bugs' --output-format json

# Real-time streaming JSON
agent -p 'Run tests' --output-format stream-json --stream-partial-output
```

**Force mode (auto-apply changes without confirmation):**

```bash
agent -p 'Fix all linting errors' --force
```

**Media support:**

```bash
agent -p 'Analyze this screenshot: screenshot.png'
```

### ⚠️ Using with AI Agents / Automation (tmux required)

**CRITICAL:** When running Cursor CLI from automated environments (AI agents, scripts, subprocess calls), the CLI requires a real TTY. Direct execution will hang indefinitely.

**The Solution: Use tmux**

```bash
# 1. Install tmux if not available
sudo apt install tmux  # Ubuntu/Debian
brew install tmux      # macOS

# 2. Create a tmux session
tmux kill-session -t cursor 2>/dev/null || true
tmux new-session -d -s cursor

# 3. Navigate to project
tmux send-keys -t cursor "cd /path/to/project" Enter
sleep 1

# 4. Run Cursor agent
tmux send-keys -t cursor "agent 'Your task here'" Enter

# 5. Handle workspace trust prompt (first run)
sleep 3
tmux send-keys -t cursor "a"  # Trust workspace

# 6. Wait for completion
sleep 60  # Adjust based on task complexity

# 7. Capture output
tmux capture-pane -t cursor -p -S -100

# 8. Verify results
ls -la /path/to/project/
```

**Why this works:**
- tmux provides a persistent pseudo-terminal (PTY)
- Cursor's TUI requires interactive terminal capabilities
- Direct `agent` calls from subprocess/exec hang without TTY

**What does NOT work:**
```bash
# ❌ These will hang indefinitely:
agent "task"                    # No TTY
agent -p "task"                 # No TTY  
subprocess.run(["agent", ...])  # No TTY
script -c "agent ..." /dev/null # May crash Cursor
```

## Rules & Configuration

The agent automatically loads rules from:
- `.cursor/rules`
- `AGENTS.md`
- `CLAUDE.md`

Use `/rules` command to create and edit rules directly from the CLI.

## MCP Integration

MCP servers are automatically loaded from `mcp.json` configuration.

Enable/disable servers on the fly:

```
/mcp enable server-name
/mcp disable server-name
```

**Note:** Server names with spaces are fully supported.

## Workflows

### Code Review

Perform a code review on the current changes or a specific branch:

```bash
agent -p 'Review the changes in the current branch against main. Focus on security and performance.'
```

### Refactoring

Refactor code for better readability or performance:

```bash
agent -p 'Refactor src/utils.ts to reduce complexity and improve type safety.'
```

### Debugging

Analyze logs or error messages to find the root cause:

```bash
agent -p 'Analyze the following error log and suggest a fix: [paste log here]'
```

### Git Integration

Automate git operations with context awareness:

```bash
agent -p 'Generate a commit message for the staged changes adhering to conventional commits.'
```

### Batch Processing (CI/CD)

Run automated checks in CI pipelines:

```bash
# Set API key in CI environment
export CURSOR_API_KEY=$CURSOR_API_KEY

# Run security audit with JSON output
agent -p 'Audit this codebase for security vulnerabilities' --output-format json --force

# Generate test coverage report
agent -p 'Run tests and generate coverage report' --output-format text
```

### Multi-file Analysis

Use context selection to analyze multiple files:

```bash
agent
# Then in interactive mode:
@src/api/
@src/models/
Review the API implementation for consistency with our data models
```
