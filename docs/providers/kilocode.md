---
summary: "Use Kilo Gateway's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Kilo Gateway in OpenClaw
---

# Kilo Gateway

Kilo Gateway provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting an API key

1. Go to [app.kilo.ai](https://app.kilo.ai)
2. Sign in or create an account
3. Navigate to API Keys and generate a new key

## CLI setup

```bash
openclaw onboard --kilocode-api-key <key>
```

Or set the environment variable:

```bash
export KILOCODE_API_KEY="your-api-key"
```

## Config snippet

```json5
{
  env: { KILOCODE_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kilocode/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Surfaced model refs

The built-in Kilo Gateway catalog currently surfaces these model refs:

- `kilocode/anthropic/claude-opus-4.6` (default)
- `kilocode/z-ai/glm-5:free`
- `kilocode/minimax/minimax-m2.5:free`
- `kilocode/anthropic/claude-sonnet-4.5`
- `kilocode/openai/gpt-5.2`
- `kilocode/google/gemini-3-pro-preview`
- `kilocode/google/gemini-3-flash-preview`
- `kilocode/x-ai/grok-code-fast-1`
- `kilocode/moonshotai/kimi-k2.5`

## Notes

- Model refs are `kilocode/<provider>/<model>` (e.g., `kilocode/anthropic/claude-opus-4.6`).
- Default model: `kilocode/anthropic/claude-opus-4.6`
- Base URL: `https://api.kilo.ai/api/gateway/`
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- Kilo Gateway uses a Bearer token with your API key under the hood.
