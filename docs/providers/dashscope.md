---
summary: "Use Dashscope (Aliyun) models in OpenClaw"
read_when:
  - You want Dashscope / Aliyun Qwen models in OpenClaw
  - You need Dashscope API key setup or region selection
title: "Dashscope (Aliyun)"
---

# Dashscope (Aliyun)

Dashscope is Aliyun's AI API platform, providing access to the **Qwen**, **DeepSeek** model
family via an OpenAI-compatible endpoint. The default model is **Qwen3 Max**
(`qwen3-max`), a high-capability general-purpose model.

Get your API key at: [https://bailian.console.aliyun.com/](https://bailian.console.aliyun.com/)

## Choose a region

Dashscope is available in three regions:

| Region             | Endpoint                                                 |
| ------------------ | -------------------------------------------------------- |
| CN (default)       | `https://dashscope.aliyuncs.com/compatible-mode/v1`      |
| SG (International) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| US (Virginia)      | `https://dashscope-us.aliyuncs.com/compatible-mode/v1`   |

When running `openclaw onboard`, the wizard prompts you to select a region.

## Setup

### Via CLI wizard (recommended)

```bash
openclaw onboard --auth-choice dashscope-api-key
```

Or non-interactive:

```bash
openclaw onboard --auth-choice dashscope-api-key --dashscope-api-key "$DASHSCOPE_API_KEY"
```

The wizard prompts you to pick a region (CN / SG / US) and writes the config automatically.

### Manual config

```json5
{
  env: { DASHSCOPE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "dashscope/qwen3-max" } } },
  models: {
    mode: "merge",
    providers: {
      dashscope: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "${DASHSCOPE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "qwen3-max",
            name: "Qwen3 Max",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

For international users (SG endpoint):

```json5
{
  models: {
    providers: {
      dashscope: {
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    },
  },
}
```

## Configure via `openclaw configure`

Use the interactive config wizard to set Dashscope without editing JSON:

1. Run `openclaw configure`.
2. Select **Model/auth**.
3. Choose **Dashscope**.
4. Enter your API key when prompted.
5. Pick a region (CN / SG / US).

## Configuration options

- `models.providers.dashscope.baseUrl`: region endpoint (CN, SG, or US — see table above).
- `models.providers.dashscope.api`: `openai-completions` (OpenAI-compatible).
- `models.providers.dashscope.apiKey`: Dashscope API key (`DASHSCOPE_API_KEY`).
- `models.providers.dashscope.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias models you want in the allowlist.
- `models.mode`: keep `merge` if you want to add Dashscope alongside built-ins.

## Notes

- Model refs use `dashscope/<model-id>` (example: `dashscope/qwen3-max`).
- Default context window: 262 144 tokens; default max output: 65 536 tokens.
- Dashscope pricing may vary; set accurate cost values in `models.json` for tracking.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- Use `openclaw models list` and `openclaw models set dashscope/qwen3-max` to switch.
