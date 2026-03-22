---
summary: "Use DeepInfra's unified API to access the most popular open source models in OpenClaw"
read_when:
  - You want a single API key for the top open source LLMs
  - You want to run models via DeepInfra's API in OpenClaw
---

# DeepInfra

DeepInfra provides a **unified API** that routes requests to the most popular open source models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting an API key

1. Go to [https://deepinfra.com/](https://deepinfra.com/)
2. Sign in or create an account
3. Navigate to Dashboard / Keys and generate a new API key or use the auto created one

## CLI setup

```bash
openclaw onboard --deepinfra-api-key <key>
```

Or set the environment variable:

```bash
export DEEPINFRA_API_KEY="<your-deepinfra-api-key>" # pragma: allowlist secret
```

## Config snippet

```json5
{
  env: { DEEPINFRA_API_KEY: "<your-deepinfra-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "deepinfra/zai-org/GLM-5" },
    },
  },
}
```

## Available models

OpenClaw dynamically discovers available DeepInfra models at startup. Use
`/models deepinfra` to see the full list of models available with your account.

Any model available on [DeepInfra.com](https://deepinfra.com/) can be used with the `deepinfra/` prefix:

```
deepinfra/MiniMaxAI/MiniMax-M2.5
deepinfra/zai-org/GLM-5
deepinfra/moonshotai/Kimi-K2.5
...and many more
```

## Notes

- Model refs are `deepinfra/<provider>/<model>` (e.g., `deepinfra/Qwen/Qwen3-Max`).
- Default model: `deepinfra/zai-org/GLM-5`
- Base URL: `https://api.deepinfra.com/v1/openai/`
