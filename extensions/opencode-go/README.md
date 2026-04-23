# OpenCode Go Provider

Bundled provider plugin for [OpenCode Go](https://opencode.ai) - a curated catalog of coding-focused AI models.

## Overview

OpenCode Go provides a single API key access to high-performance coding models:

- Kimi (Moonshot AI)
- GLM (Zhipu AI)
- MiniMax

## Authentication

Environment variables:

- `OPENCODE_API_KEY` - Primary API key
- `OPENCODE_ZEN_API_KEY` - Alias for the same key

CLI flag:

- `--opencode-go-api-key <key>`

Get your API key at: https://opencode.ai/auth

## Default Model

- `opencode-go/kimi-k2.6` (aliased as "Kimi")

## Model Aliases

The Go provider registers friendly aliases for coding models:

- `Kimi` → `opencode-go/kimi-k2.6`
- `GLM` → `opencode-go/glm-5`
- `MiniMax` → `opencode-go/minimax-m2.5`

## Design Notes

OpenCode Go uses a **static model list** optimized for coding tasks. This is intentional - Go provides a curated, stable catalog of high-performance coding models through a single API key.

The provider uses passthrough Gemini replay hooks for Google-backed models and minimal replay policy for other models.

## Sibling Provider

OpenCode Zen (`opencode`) is the companion provider for general-purpose models (Claude, GPT, Gemini). Both share the same API key.

## Tests

```bash
pnpm test:extensions -- --testPathPattern=opencode-go
```

## See Also

- `opencode` - General-purpose multi-model provider
