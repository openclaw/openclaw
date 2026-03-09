---
summary: "Use OpenCode Go (Kimi, GLM, MiniMax) with OpenClaw"
read_when:
  - You want OpenCode Go for model access
  - You want OpenCode Go without changing OpenCode Zen behavior
title: "OpenCode Go"
---

# OpenCode Go

OpenCode Go is a separate OpenCode provider path for the Go-hosted model catalog.
It is configured with the `opencode-go` provider id and does **not** replace or
change [OpenCode Zen](/providers/opencode).

## Supported models

- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

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

## Routing behavior

OpenCode Go uses two transport shapes internally:

- `kimi-k2.5` and `glm-5` use an OpenAI-compatible chat/completions flow
- `minimax-m2.5` uses an Anthropic messages flow

OpenClaw handles that routing automatically when the model ref uses
`opencode-go/...`.

## Notes

- Auth defaults to `OPENCODE_API_KEY`.
- OpenCode Go is additive. Existing `opencode/...` Zen configs stay unchanged.
- If you want the curated Zen catalog instead, use [OpenCode Zen](/providers/opencode).
