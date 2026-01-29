# Clawdbot + Claude-Mem Setup Guide

Complete setup guide for integrating Clawdbot with Claude-Mem persistent memory.

---

## Overview

This guide walks you through:
1. Installing Clawdbot (AI messaging gateway)
2. Installing Claude-Mem (persistent memory system)
3. Connecting them via the `memory-claudemem` plugin

**What you get:**
- Clawdbot routes messages between you and AI across multiple channels (Telegram, Discord, WhatsApp, etc.)
- Claude-Mem captures observations from every tool call and injects relevant context into future sessions
- Progressive disclosure memory tools (`memory_search`, `memory_observations`)

---

## Prerequisites

- **Node.js 22+** (required for both Clawdbot and Claude-Mem)
- **macOS, Linux, or Windows (WSL2)**
- **Git** (for installing from source)

Check your Node version:
```bash
node -v
# Should show v22.x.x or higher
```

---

## Part 1: Install Clawdbot

### Option A: Quick Install (Recommended)

```bash
curl -fsSL https://clawd.bot/install.sh | bash
```

Windows (PowerShell):
```powershell
iwr -useb https://clawd.bot/install.ps1 | iex
```

This:
- Installs Node 22+ if needed
- Installs `clawdbot` globally via npm
- Runs the onboarding wizard

### Option B: Manual Install

If you already have Node 22+:

```bash
npm install -g clawdbot@latest
```

Then run onboarding:

```bash
clawdbot onboard --install-daemon
```

### Verify Installation

```bash
clawdbot --version
clawdbot doctor
```

### Common Issue: "clawdbot not found"

If your shell can't find `clawdbot`, add npm's global bin to your PATH:

```bash
# Add to ~/.zshrc or ~/.bashrc
export PATH="$(npm prefix -g)/bin:$PATH"
```

Then restart your terminal or run `source ~/.zshrc`.

---

## Part 2: Install Claude-Mem

Claude-Mem is a separate system that provides persistent memory. You need to install it independently.

### Option A: Via Claude Code Plugin (if using Claude Code)

If you use Claude Code (Anthropic's CLI), install claude-mem as a plugin:

```bash
# In a Claude Code session:
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code. The worker starts automatically.

### Option B: Manual Installation (Standalone)

Clone the repository:

```bash
cd ~/Scripts  # or wherever you keep projects
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
```

Install dependencies and build:

```bash
npm install
npm run build
```

Start the worker:

```bash
npm run worker
# Or run in background:
nohup npm run worker > /tmp/claude-mem-worker.log 2>&1 &
```

### Verify Claude-Mem is Running

The worker runs on port 37777 by default.

```bash
curl http://localhost:37777/api/health
# Should return: OK or {"status":"ok"}
```

Open the web viewer:
```bash
open http://localhost:37777
```

---

## Part 3: Enable the Memory-Claudemem Plugin

The `memory-claudemem` plugin connects Clawdbot to the Claude-Mem worker.

### Step 1: Disable Built-in Memory (Optional but Recommended)

Clawdbot has its own memory system. To avoid conflicts, disable it:

```bash
clawdbot config set agents.defaults.memorySearch.enabled false
```

Verify:
```bash
clawdbot config get agents.defaults.memorySearch.enabled
# Should return: false
```

### Step 2: Enable the Claude-Mem Plugin

The plugin is bundled in the `extensions/memory-claudemem` directory. Enable it:

```bash
clawdbot config set plugins.memory-claudemem.workerUrl "http://localhost:37777"
```

Optional: Adjust timeout (default 10 seconds):
```bash
clawdbot config set plugins.memory-claudemem.workerTimeout 15000
```

### Step 3: Verify Plugin Status

Check the worker connection:

```bash
clawdbot claude-mem status
```

Expected output:
```
✓ Worker running at http://localhost:37777
```

If you see `✗ Worker not responding`, make sure Claude-Mem is running (see Part 2).

---

## Part 4: Test the Integration

### Test 1: Search Memories

```bash
clawdbot claude-mem search "authentication"
```

This queries Claude-Mem for observations matching "authentication".

### Test 2: Run an Agent with Memory

Send a test message through Clawdbot:

```bash
clawdbot agent --message "List files in the current directory"
```

This should:
1. Execute the task
2. Record the observation to Claude-Mem (fire-and-forget)
3. Future queries will have this context injected

### Test 3: Verify Observation Recording

Open the Claude-Mem web viewer:
```bash
open http://localhost:37777
```

You should see new observations for tool calls made by Clawdbot.

---

## Configuration Reference

### Full Config Example

Edit `~/.clawdbot/config.yml`:

```yaml
# Disable built-in memory (use claude-mem instead)
agents:
  defaults:
    memorySearch:
      enabled: false

# Enable claude-mem plugin
plugins:
  memory-claudemem:
    workerUrl: http://localhost:37777
    workerTimeout: 10000
```

### Rollback to Built-in Memory

If you want to switch back to Clawdbot's built-in memory:

```yaml
agents:
  defaults:
    memorySearch:
      enabled: true

plugins:
  memory-claudemem:
    enabled: false
```

---

## Available Tools

When the plugin is active, these tools are available to the AI agent:

| Tool | Description |
|------|-------------|
| `memory_search` | Search past observations. Returns compact results with IDs. |
| `memory_observations` | Get full details for specific observation IDs. |

### 3-Layer Workflow

1. **Search** (`memory_search`): Get index with IDs (~50-100 tokens/result)
2. **Filter**: Review results, identify relevant IDs
3. **Fetch** (`memory_observations`): Get full details (~500-1000 tokens/result)

This pattern saves ~10x tokens compared to fetching everything.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `clawdbot claude-mem status` | Check if the worker is responding |
| `clawdbot claude-mem search <query>` | Search memories (JSON output) |

Options for search:
```bash
clawdbot claude-mem search "authentication" --limit 20
```

---

## Troubleshooting

### Worker Not Responding

1. Check if Claude-Mem is running:
   ```bash
   curl http://localhost:37777/api/health
   ```

2. If not running, start it:
   ```bash
   cd ~/Scripts/claude-mem
   npm run worker
   ```

3. Check logs:
   ```bash
   tail -f /tmp/claude-mem-worker.log
   ```

### Plugin Not Loading

1. Check plugin list:
   ```bash
   clawdbot plugins list
   ```

2. Look for `memory-claudemem` in the output.

3. If missing, check the config:
   ```bash
   clawdbot config get plugins.memory-claudemem
   ```

### No Observations Being Recorded

1. Enable debug logging:
   ```bash
   clawdbot config set logging.level debug
   ```

2. Run a command and check logs:
   ```bash
   clawdbot agent --message "test"
   tail -f ~/.clawdbot/logs/gateway.log | grep claude-mem
   ```

### Context Not Being Injected

1. Check that there are observations in Claude-Mem (via web UI at http://localhost:37777)
2. Ensure the prompt is longer than 5 characters (short prompts skip injection)
3. Check logs for "injecting X memories into context"

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│    Clawdbot      │     │    Claude-Mem    │
│    Gateway       │     │     Worker       │
├──────────────────┤     ├──────────────────┤
│                  │     │                  │
│  before_agent    │────▶│  context inject  │
│  after_tool_call │────▶│  POST /observe   │
│                  │     │                  │
│  memory_search   │────▶│  GET /search     │
│  memory_observations──▶│  POST /batch     │
│                  │     │                  │
└──────────────────┘     └──────────────────┘
        │                        │
        └────────────────────────┘
              http://localhost:37777
```

**Hooks:**
- `before_agent_start`: Injects relevant memories as context
- `after_tool_call`: Records observations (fire-and-forget)

**Tools:**
- `memory_search`: Queries Claude-Mem's search API
- `memory_observations`: Fetches full observation details

---

## Next Steps

- **Set up messaging channels**: `clawdbot channels add telegram` (or discord, slack, etc.)
- **Configure the AI model**: `clawdbot config set agents.defaults.model claude-sonnet-4-20250514`
- **Start the gateway**: `clawdbot gateway run`
- **Open the dashboard**: `clawdbot dashboard`

For more information:
- Clawdbot docs: https://docs.clawd.bot
- Claude-Mem docs: https://docs.claude-mem.ai
