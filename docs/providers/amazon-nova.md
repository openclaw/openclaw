---
summary: "Configure Nova models via nova.amazon.com"
read_when:
  - You want to use Nova models via the API
  - You need to set up NOVA_API_KEY authentication
  - You want copy/paste config for Nova
title: "Nova"
---

# Nova

Nova provides frontier AI models with extended thinking capabilities. Configure the
provider and set the default model to `amazon-nova/nova-2-lite-v1`.

Available models:

- `nova-2-lite-v1` - 1M context, 65k output, multimodal (text + image), extended thinking
- `nova-2-pro-v1` - 1M context, 65k output, multimodal (text + image), extended thinking

```bash
openclaw onboard --auth-choice amazon-nova-api-key
```

## Usage

```bash
openclaw agent --model amazon-nova/nova-2-lite-v1
```

## Extended Thinking

Nova models support extended reasoning. Use the `--thinking` flag:

```bash
openclaw agent --thinking high
```

Or configure it in your model params:

```json5
{
  agents: {
    defaults: {
      model: { primary: "amazon-nova/nova-2-lite-v1" },
      models: {
        "amazon-nova/nova-2-lite-v1": {
          alias: "Nova 2 Lite",
          params: {
            reasoning_effort: "high", // "low", "medium", "high"
          },
        },
      },
    },
  },
}
```

| Level    | Behavior                     |
| -------- | ---------------------------- |
| `low`    | Fast, basic reasoning        |
| `medium` | Balanced reasoning and speed |
| `high`   | Deep, thorough analysis      |

## Config snippet

```json5
{
  env: { NOVA_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      model: { primary: "amazon-nova/nova-2-lite-v1" },
      models: {
        "amazon-nova/nova-2-lite-v1": { alias: "Nova 2 Lite" },
        "amazon-nova/nova-2-pro-v1": { alias: "Nova 2 Pro" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "amazon-nova": {
        baseUrl: "https://api.nova.amazon.com/v1",
        apiKey: "${NOVA_API_KEY}",
        api: "openai-completions",
        headers: { "Accept-Encoding": "identity" },
        models: [
          {
            id: "nova-2-lite-v1",
            name: "Amazon Nova 2 Lite",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 65535,
            compat: {
              supportsReasoningEffort: true,
              supportsDeveloperRole: false,
              maxTokensField: "max_tokens",
            },
          },
          {
            id: "nova-2-pro-v1",
            name: "Amazon Nova 2 Pro",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 65535,
            compat: {
              supportsReasoningEffort: true,
              supportsDeveloperRole: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
    },
  },
}
```

## Notes

- The `Accept-Encoding: identity` header is required by the Nova API.
- Model refs use `amazon-nova/<modelId>` format.
