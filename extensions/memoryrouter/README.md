# MemoryRouter Plugin for OpenClaw

**Persistent AI memory for any model.** MemoryRouter gives your AI agent persistent memory across all conversations — every message is automatically stored and relevant context is retrieved when you ask questions.

## How It Works

```
Without MemoryRouter:  OpenClaw → Anthropic/OpenAI/etc.
With MemoryRouter:     OpenClaw → MemoryRouter → Anthropic/OpenAI/etc.
```

When enabled, OpenClaw intercepts LLM API calls and routes them through MemoryRouter, which:

1. **Retrieves** relevant context from your memory vault (semantic search)
2. **Injects** it into the prompt (context augmentation)
3. **Forwards** the request to the actual AI provider
4. **Stores** the conversation for future retrieval

Zero code changes. Zero workflow disruption. Works with any supported model.

## Quick Start

```bash
# 1. Get your memory key at https://memoryrouter.ai
# 2. Enable MemoryRouter
openclaw memoryrouter mk_YOUR_KEY

# 3. That's it! All conversations now have persistent memory.
```

## Commands

### CLI Commands

```bash
openclaw memoryrouter mk_abc123    # Enable with your memory key
openclaw memoryrouter off           # Disable
openclaw memoryrouter status        # Show status + vault stats
openclaw memoryrouter upload        # Upload workspace files to memory vault
openclaw memoryrouter upload ./docs # Upload specific directory
openclaw memoryrouter delete        # Clear all memories from vault
openclaw memoryrouter setup         # Interactive setup wizard
```

### Chat Commands

From any connected channel (Telegram, Discord, Slack, etc.):

```
/memoryrouter              — Show status & vault stats
/memoryrouter mk_abc123   — Enable with memory key
/memoryrouter off          — Disable
/memoryrouter on           — Re-enable (if key exists)
/memoryrouter ping         — Test API connectivity
```

## Configuration

MemoryRouter config lives in your OpenClaw config file:

```json
{
  "memoryRouter": {
    "enabled": true,
    "key": "mk_YOUR_KEY"
  }
}
```

### Options

| Field      | Type    | Default                          | Description                             |
| ---------- | ------- | -------------------------------- | --------------------------------------- |
| `enabled`  | boolean | `false`                          | Enable/disable MemoryRouter routing     |
| `key`      | string  | —                                | Your memory key (starts with `mk_`)     |
| `endpoint` | string  | `https://api.memoryrouter.ai/v1` | API endpoint (override for self-hosted) |

## Supported Providers

| Provider               | Supported |
| ---------------------- | --------- |
| Anthropic (Claude)     | ✅        |
| OpenAI (GPT, o-series) | ✅        |
| Google (Gemini)        | ✅        |
| xAI (Grok)             | ✅        |
| DeepSeek               | ✅        |
| Mistral                | ✅        |
| Cerebras               | ✅        |
| OpenRouter             | ✅        |
| Azure OpenAI           | ✅        |
| Ollama (local)         | ✅        |

Unsupported providers silently fall back to direct API calls.

## Architecture

The integration has three components:

1. **Core routing** (`src/agents/memoryrouter-integration.ts`) — Intercepts LLM calls, swaps base URLs, injects `X-Memory-Key` headers
2. **CLI commands** (`src/cli/memoryrouter-cli.ts`) — Terminal commands for setup, status, upload
3. **This plugin** (`extensions/memoryrouter/`) — Chat commands for in-conversation control

### Subagent Behavior

- **Main agent** conversations: stored in vault ✅
- **Subagent** conversations: NOT stored (they're ephemeral workers)

Detection: `X-Memory-Store: false` header sent for subagent sessions.

## Upload Command

Upload your workspace files to the memory vault:

```bash
openclaw memoryrouter upload
```

This scans for:

- `MEMORY.md` (root)
- `memory/**/*.md` (memory directory)
- `AGENTS.md`, `TOOLS.md` (context files)
- Session transcripts (`.jsonl`)

Files are chunked and embedded for semantic search.

## Links

- **MemoryRouter**: https://memoryrouter.ai
- **API Docs**: https://memoryrouter.ai/docs
- **OpenClaw**: https://github.com/nicepkg/openclaw

## License

MIT
