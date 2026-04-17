# OpenCode Zen Provider

Bundled provider plugin for [OpenCode Zen](https://opencode.ai) - a curated multi-model AI proxy service.

## Overview

OpenCode Zen provides a single API key access to multiple frontier models:

- Claude (Anthropic)
- GPT (OpenAI)
- Gemini (Google)
- And more via the Zen catalog

## Authentication

Environment variables:

- `OPENCODE_API_KEY` - Primary API key
- `OPENCODE_ZEN_API_KEY` - Alias for the same key

CLI flag:

- `--opencode-zen-api-key <key>`

Get your API key at: https://opencode.ai/auth

## Default Model

- `opencode/claude-opus-4-7` (aliased as "Opus")

## Design Notes

Unlike OpenRouter (which has dynamic model discovery), OpenCode Zen uses a **static model list**. This is intentional - Zen provides a curated, stable catalog of models through a single API key.

The provider uses passthrough Gemini replay hooks for Google-backed models and minimal replay policy for other models.

## Sibling Provider

OpenCode Go (`opencode-go`) is the companion provider for coding-focused models (Kimi, GLM, MiniMax). Both share the same API key.

## Tests

```bash
pnpm test:extensions -- --testPathPattern=opencode
```

## See Also

- `opencode-go` - Coding-focused models provider
