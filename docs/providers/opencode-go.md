---
summary: "Use OpenCode Go (subscription open models) with OpenClaw"
read_when:
  - You want OpenCode Go for lower-cost model access
  - You want OpenCode's subscription tier for open coding models
title: "OpenCode Go"
---

# OpenCode Go

OpenCode Go is the **$10/month OpenCode subscription** for a curated set of open coding models.
It is an optional, hosted model access path that uses an API key and the `opencode-go` provider.
Go is currently in beta.

## CLI setup

```bash
openclaw onboard --auth-choice opencode-go
# or non-interactive
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.5" } } },
}
```

## Notes

- `OPENCODE_GO_API_KEY` is also supported.
- OpenCode Go uses the same OpenCode API key as OpenCode Zen.
- OpenCode Go is subscription-based, while OpenCode Zen is pay-as-you-go.
- Current Go models are `glm-5`, `kimi-k2.5`, and `minimax-m2.5`.
