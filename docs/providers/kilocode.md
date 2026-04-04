---
title: "Kilo Gateway"
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
openclaw onboard --auth-choice kilocode-api-key
```

Or set the environment variable:

```bash
export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
```

## Config snippet

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

## Default model

The default model is `kilocode/kilo/auto`, a provider-owned smart-routing
model managed by Kilo Gateway.

OpenClaw treats `kilocode/kilo/auto` as the stable default ref, but does not
publish a source-backed task-to-upstream-model mapping for that route.

## Available models

OpenClaw dynamically discovers available models from the Kilo Gateway at startup. Use
`/models kilocode` to see the full list of models available with your account.

Any model available on the gateway can be used with the `kilocode/` prefix:

```
kilocode/kilo/auto              (default - smart routing)
kilocode/anthropic/claude-sonnet-4
kilocode/openai/gpt-5.4
kilocode/google/gemini-3-pro-preview
...and many more
```

## Notes

- Model refs are `kilocode/<model-id>` (e.g., `kilocode/anthropic/claude-sonnet-4`).
- Default model: `kilocode/kilo/auto`
- Base URL: `https://api.kilo.ai/api/gateway/`
- Bundled fallback catalog always includes `kilocode/kilo/auto` (`Kilo Auto`) with
  `input: ["text", "image"]`, `reasoning: true`, `contextWindow: 1000000`,
  and `maxTokens: 128000`
- At startup, OpenClaw tries `GET https://api.kilo.ai/api/gateway/models` and
  merges discovered models ahead of the static fallback catalog
- Exact upstream routing behind `kilocode/kilo/auto` is owned by Kilo Gateway,
  not hard-coded in OpenClaw
- Kilo Gateway is documented in source as OpenRouter-compatible, so it stays on
  the proxy-style OpenAI-compatible path rather than native OpenAI request shaping
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- Kilo Gateway uses a Bearer token with your API key under the hood.
