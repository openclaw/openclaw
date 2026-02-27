---
summary: "Use OpenCode Go models with OpenClaw"
read_when:
  - You want OpenCode Go models in OpenClaw
  - You need OPENCODE_GO_API_KEY setup
title: "OpenCode Go"
---

# OpenCode Go

OpenCode Go is a regional variant of [OpenCode Zen](/providers/opencode) that provides
access to a curated subset of models optimized for coding agents. It uses the
`opencode-go` provider with an OpenCode API key.

## Model overview

- **glm-5**: GLM-5, 204K context, reasoning
- **minimax-m2.5**: MiniMax M2.5, 200K context, reasoning
- **kimi-k2.5**: Kimi K2.5, 131K context, reasoning + image input

## CLI setup

```bash
openclaw onboard --auth-choice opencode-go
# or non-interactive
openclaw onboard --opencode-go-api-key "$OPENCODE_GO_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_GO_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "opencode-go/minimax-m2.5" } } },
}
```

## Notes

- `OPENCODE_API_KEY` is also supported as a fallback.
- OpenCode Go uses the API endpoint `https://opencode.ai/zen/go/v1`.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
