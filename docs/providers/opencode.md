---
summary: "Use OpenCode Zen and Go catalogs with OpenClaw"
read_when:
  - You want OpenCode-hosted model access
  - You want to pick between the Zen and Go catalogs
title: "OpenCode"
---

# OpenCode

OpenCode exposes two hosted catalogs in OpenClaw:

- `opencode/...` for the **Zen** catalog
- `opencode-go/...` for the **Go** catalog

Both catalogs use the same OpenCode API key. OpenClaw keeps the runtime provider ids
split so upstream per-model routing stays correct, but onboarding and docs treat them
as one OpenCode setup.

## CLI setup

### Zen catalog

```bash
openclaw onboard --auth-choice opencode-zen
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

### Go catalog

```bash
openclaw onboard --auth-choice opencode-go
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Catalogs

### Zen

- Runtime provider: `opencode`
- Example models: `opencode/claude-opus-4-6`, `opencode/gpt-5.4`, `opencode/gemini-3-pro`
- Best when you want the curated OpenCode multi-model proxy

### Go

- Runtime provider: `opencode-go`
- Example models: `opencode-go/kimi-k2.5`, `opencode-go/glm-5`, `opencode-go/minimax-m2.5`
- Best when you want the OpenCode-hosted Kimi/GLM/MiniMax lineup

## Notes

- `OPENCODE_ZEN_API_KEY` is also supported.
- Entering one OpenCode key during setup stores credentials for both runtime providers.
- You sign in to OpenCode, add billing details, and copy your API key.
- Billing and catalog availability are managed from the OpenCode dashboard.
