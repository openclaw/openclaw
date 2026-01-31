---
name: miyabi-orchestrator
description: "Connect to Miyabi Agent Society for multi-agent orchestration. Run agents, check status, execute workflows via tmux and MCP."
metadata: {"moltbot":{"emoji":"🎭","requires":{"bins":["tmux","gh"]},"os":["darwin","linux"],"paths":["~/Dev/01-miyabi"]}}
---

# Miyabi Orchestrator Skill

Interface with the Miyabi Agent Society - a multi-agent orchestration system with 21+ specialized AI agents.

## Quick Start

### Check Agent Status

```bash
# List all tmux sessions
tmux list-sessions

# Check miyabi agent session
tmux send-keys -t miyabi:agents.0 "status" Enter

# Or use agent status script
~/Dev/01-miyabi/.tmux/scripts/agent-status.sh
```

### Run Tasks via Agents

```bash
# Send task to Conductor (しきるん)
tmux send-keys -t %0 "Execute task: Implement new feature" Enter

# Send task to CodeGen (カエデ)
tmux send-keys -t %1 "Generate code for user authentication" Enter

# Broadcast to all agents
~/Dev/01-miyabi/.tmux/scripts/a2a-broadcast.sh "System maintenance starting"
```

## Core Agents

| Agent | Role | Pane ID | Description |
|-------|------|---------|-------------|
| しきるん | Conductor | %0 | Task distribution, orchestration |
| カエデ | CodeGen | %1 | Code generation, implementation |
| サクラ | Review | %2 | Code review, QA |
| ツバキ | PR | %3 | Pull request management |
| ボタン | Deploy | %4 | Deployment, release |
| ながれるん | Workflow | %5 | n8n workflow automation |

## MCP Tools Integration

```bash
# List MCP categories
mcp_list_categories

# Search GitHub tools
mcp_search_tools --category github

# Execute workflow via n8n MCP
execute_n8n_workflow --workflow-id xxx
```

## GitHub Workflows

```bash
# Create issue for task declaration
gh issue create --repo ShunsukeHayashi/clawdbot-miyabi \
  --title "[P0] Implement feature" \
  --body "## 作業宣言

担当: Clawdbot
開始: $(date '+%Y-%m-%d %H:%M')"

# Comment on existing issue
gh issue comment 42 --repo ShunsukeHayashi/clawdbot-miyabi \
  --body "🚀 作業開始"
```

## Project Navigation

```bash
# Main platform
cd ~/Dev/01-miyabi/_core/miyabi-private

# MCP Bundle
cd ~/Dev/01-miyabi/_mcp/miyabi-mcp-bundle

# Showcase App
cd ~/Dev/01-miyabi/miyabi-society-showcase
```

## Development Commands

```bash
# Miyabi Private dev
cd ~/Dev/01-miyabi/_core/miyabi-private
make run          # Run miyabi CLI
npm run dev       # Next.js dev server

# MCP Bundle
cd ~/Dev/01-miyabi/_mcp/miyabi-mcp-bundle
npm run dev       # MCP server (172+ tools)

# Showcase
cd ~/Dev/01-miyabi/miyabi-society-showcase
npm run dev       # Demo app
```

## Agent Communication

Use permanent pane IDs (%N) for reliable targeting:

```bash
# Correct - using permanent ID
tmux send-keys -t %0 "message" Enter

# Incorrect - unstable index
tmux send-keys -t miyabi:agents.0 "message" Enter
```

## Workflow Patterns

### Hub & Spoke (Standard)
```
Conductor → Individual Agents → Conductor
```

### Pipeline (Sequential)
```
CodeGen → Review → PR → Deploy
```

### Autonomous Trinity (Parallel)
```
Claude Code + 2 Codex agents working together
```

## Notes

- Always use GitHubOps protocol: Issue declaration → Work → PR
- Use PUSH communication (agents report to conductor)
- Check agent status before dispatching tasks
- Use permanent pane IDs to avoid pane renumbering issues
