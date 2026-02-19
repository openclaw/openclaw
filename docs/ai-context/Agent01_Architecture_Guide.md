# Agent Architecture Guide

## Overview

MAIBOT integrates PI Agent (`@mariozechner/pi-*` packages) for RPC-based agent operations.

## Package Structure

Core PI Agent packages (from package.json):
- `@mariozechner/pi-agent-core@0.49.3` — Core agent runtime
- `@mariozechner/pi-ai@0.49.3` — AI model integrations
- `@mariozechner/pi-coding-agent@0.49.3` — Coding-specific agent
- `@mariozechner/pi-tui@0.49.3` — Terminal UI

## Key Integration Points

### 1. Agent Scope (src/agents/agent-scope.ts)
Defines workspace boundaries and file access patterns.

### 2. CLI Runner (src/agents/cli-runner.ts)
Orchestrates PI Agent execution through CLI.

### 3. RPC Mode
```bash
pnpm openclaw:rpc  # Runs agent in RPC mode with JSON output
```

## Standard Workflow

1. User sends message (WhatsApp/Telegram/Discord/etc.)
2. Gateway routes to handler
3. If agent needed, spawn PI Agent via RPC
4. Agent performs operation (code analysis, file editing)
5. Results returned through RPC
6. Gateway sends formatted response

## Best Practices

- Verify agent workspace access before file operations
- Use JSON mode for programmatic interaction
- Degrade gracefully on agent failures (don't crash gateway)
- Use auth-profiles for model failover (Anthropic → OpenAI)

## Testing

- Unit: `src/agents/agent-scope.test.ts`, `cli-runner.test.ts`
- Live: `CLAWDBOT_LIVE_TEST=1 pnpm test:live`

---

**References**:
- PI Agent Core: https://github.com/mariozechner/pi
- MAIBOT Agent Source: src/agents/
- Integration Tests: src/agents/*.test.ts

*Last updated: 2026-01-30*

