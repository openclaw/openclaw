---
summary: "Configure Nebius TokenFactory (OpenAI-compatible) with auto-discovered models"
read_when:
  - You want to use Nebius TokenFactory with the OpenAI protocol
  - You need a config snippet for `NEBIUS_API_KEY`
  - You want to set the default model to Nebius
---

# Nebius (TokenFactory)

Nebius TokenFactory exposes an OpenAI-compatible API at `https://api.tokenfactory.nebius.com/v1`.
OpenClaw auto-discovers models via `/models` when a Nebius key is present and falls back to
`nebius/zai-org/GLM-4.7-FP8` as the default.

```bash
openclaw onboard --auth-choice nebius-api-key
```

## Config snippet

```json5
{
  env: { NEBIUS_API_KEY: "v1..." },
  agents: {
    defaults: {
      model: { primary: "nebius/zai-org/GLM-4.7-FP8" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      nebius: {
        baseUrl: "https://api.tokenfactory.nebius.com/v1",
        apiKey: "${NEBIUS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "zai-org/GLM-4.7-FP8",
            name: "GLM 4.7 FP8",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Model references (sample)

Discovered models use refs like `nebius/<modelId>`. Examples from `/models`:

- `nebius/zai-org/GLM-4.7-FP8`
- `nebius/meta-llama/Meta-Llama-3.3-70B-Instruct`
- `nebius/deepseek-ai/DeepSeek-R1-0528`
- `nebius/Qwen/Qwen3-235B-A22B-Instruct-2507`
- `nebius/openai/gpt-oss-120b`

> Tip: If Nebius adds new models, re-run `openclaw onboard` (or rebuild `models.json`) to
> refresh the catalog from `/models`.
