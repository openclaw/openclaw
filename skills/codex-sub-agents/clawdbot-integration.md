# Clawdbot + Codex CLI Integration Patterns

## Overview

Clawdbot can integrate with OpenAI Codex CLI in multiple ways:
1. **Provider**: Use `openai-codex` provider for ChatGPT Pro subscription routing
2. **Exec tool**: Call `codex exec` directly from Clawdbot
3. **Subagent**: Spawn a dedicated coding subagent
4. **CLI Backend**: Fallback text-only mode
5. **MCP Server**: Run Codex as MCP server for tool access

## Pattern 1: OpenAI Codex Provider

Use your ChatGPT Pro/Plus subscription with Clawdbot's built-in `openai-codex` provider.

### Config

```json5
// ~/.clawdbot/clawdbot.json
{
  agents: {
    defaults: {
      model: { 
        primary: "openai-codex/gpt-5.2",
        fallbacks: ["anthropic/claude-sonnet-4-5"]
      },
      models: {
        "openai-codex/gpt-5.2": { alias: "Codex" },
        "anthropic/claude-opus-4-5": { alias: "Opus" }
      }
    }
  }
}
```

### Auth Sync

Clawdbot auto-syncs OAuth tokens from Codex CLI:
- Source: `~/.codex/auth.json`
- Target: `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`
- Profile key: `openai-codex:codex-cli`

### Onboarding

```bash
clawdbot onboard --auth-choice openai-codex
# Or if Codex CLI is already authenticated:
codex-cli  # Clawdbot detects and imports tokens
```

## Pattern 2: Direct Exec Tool

Call Codex CLI directly from Clawdbot's exec tool for coding tasks.

### Usage

```bash
# From Clawdbot chat
> Fix the TypeScript errors in src/components

# Clawdbot runs:
exec codex exec --full-auto --cd ~/projects/medreport "fix TypeScript errors in src/components"
```

### Best Practices

- Use `--full-auto` for trusted repos
- Use `--cd` to target specific project
- Use `--json` for parsing results
- Check exit code for success/failure

### Example AGENTS.md Instruction

```markdown
## Coding Tasks

When asked to fix code, refactor, or implement features:

1. Use the codex CLI for complex coding tasks
2. Command: `codex exec --full-auto --cd <project_path> "<task>"`
3. For large changes, use interactive mode: `codex --cd <path>`
4. Report the result back to the user
```

## Pattern 3: Coding Subagent

Spawn a dedicated subagent for coding that uses Codex or runs in a sandboxed environment.

### Config

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        workspace: "~/clawd",
        model: { primary: "anthropic/claude-opus-4-5" }
      },
      {
        id: "coder", 
        workspace: "~/clawd-coder",
        model: { primary: "openai-codex/gpt-5.2" },
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "rw"
        },
        tools: {
          allow: ["exec", "read", "write", "edit", "apply_patch", "process"],
          deny: ["browser", "canvas", "cron"]
        },
        subagents: {
          allowAgents: ["main"]  // Main can spawn coder
        }
      }
    ]
  },
  tools: {
    agentToAgent: {
      enabled: true,
      allow: ["main", "coder"]
    }
  }
}
```

### Usage

From main agent:
```
sessions_spawn task="Refactor the Dashboard component to use React Query" agentId="coder"
```

The coder subagent runs with Codex model, announces result back to main chat.

## Pattern 4: CLI Backend Fallback

Configure Codex CLI as a text-only fallback when API providers fail.

### Config

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "codex",
          args: ["exec", "--full-auto"],
          output: "text"
        }
      }
    }
  }
}
```

### Notes

- CLI backends are text-only (no tool calls)
- Used as fallback when API auth fails or rate limits
- Sessions managed by Codex internally
- Good for emergencies but less capable

## Pattern 5: MCP Server Mode

Run Codex as an MCP server that Clawdbot can call.

### Setup

```bash
# Terminal 1: Start Codex MCP server
codex mcp-server

# Configure Clawdbot to connect
# In ~/.clawdbot/clawdbot.json or via skill
```

### Skill Integration

Create a skill that declares Codex MCP:

```markdown
---
name: codex-mcp
mcp:
  - name: codex
    command: codex
    args: ["mcp-server"]
---
```

## Model Handoff Patterns

### Opus → Codex Handoff

Use Opus for planning, Codex for implementation:

```json5
{
  agents: {
    list: [
      {
        id: "planner",
        model: { primary: "anthropic/claude-opus-4-5" },
        subagents: { allowAgents: ["coder"] }
      },
      {
        id: "coder",
        model: { primary: "openai-codex/gpt-5.2" }
      }
    ]
  }
}
```

Workflow:
1. User asks planner for architecture
2. Planner designs solution
3. Planner spawns coder subagent with implementation task
4. Coder implements and announces result
5. Planner reviews and responds to user

### Channel-Based Routing

Route WhatsApp to fast model, Telegram to Codex:

```json5
{
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "coder", match: { channel: "telegram" } }
  ]
}
```

## Cost Optimization

### Strategy 1: Subagent Model Override

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "openai/gpt-5-mini"  // Cheaper for subagents
      }
    }
  }
}
```

### Strategy 2: Task-Based Routing

- Quick questions → Sonnet/Mini
- Code review → Codex
- Deep analysis → Opus

### Strategy 3: Fallback Chain

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: [
          "openai-codex/gpt-5.2",
          "openai/gpt-5-mini"
        ]
      }
    }
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Codex auth not syncing | Run `codex login` then restart gateway |
| Subagent not spawning | Check `subagents.allowAgents` includes caller |
| Exec timeout | Increase `tools.exec.timeoutSec` |
| Sandbox blocks codex | Add codex binary to allowed paths |
| Wrong workspace | Use `--cd` flag explicitly |
