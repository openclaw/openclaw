# Rate Limit & MCP Guide

## Rate Limit (Max 20x subscription)

~5-hour rolling window reset. Sonnet 4.6 = Opus-level coding at 1/2 tokens → Sonnet as primary.

**Handling rate limit:**

1. Wait for running Claude Code sessions to complete
2. Stop new calls
3. Switch pending tasks → MAIBOT direct processing
4. Retry after ~30 minutes

**Fallback command:**

```bash
claude -p --model sonnet --fallback-model haiku "task"
```

## MCP Strategy

MCP loading: ~10 seconds (4~5 servers). Default load is acceptable for most tasks.

```bash
# Default (recommended, stable)
claude -p "task"

# Project MCP only
claude -p --strict-mcp-config --mcp-config .mcp.json "task"
```

> ⚠️ **Windows hang**: Never use `--strict-mcp-config --mcp-config '{}'` — hangs on Windows.

## Authentication

```
Claude Max ($200/month OAuth)
    ├── MAIBOT (OpenClaw) — setup-token
    └── Claude Code CLI — OAuth (auto-renewal)
```

Same subscription shared, auth tokens are separate. Conflicts are rare.

## Process Management (background runs)

| Action                           | Purpose               |
| -------------------------------- | --------------------- |
| `process list`                   | List running sessions |
| `process poll sessionId timeout` | Wait for completion   |
| `process log sessionId`          | Check output          |
| `process kill sessionId`         | Kill session          |
