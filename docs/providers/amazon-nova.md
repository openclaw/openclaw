---
summary: "Configure Amazon Nova 1P API (direct API, not Bedrock)"
read_when:
  - You want to use Amazon Nova models via the direct 1P API
  - You need to set up NOVA_API_KEY authentication
  - You want copy/paste config for Amazon Nova
---

# Amazon Nova (1P API)

Amazon Nova 1P API provides direct access to Nova models without going through
AWS Bedrock. This is a separate integration from the Bedrock provider.

Available models:

- `nova-2-lite-v1` - 1M context, 65k output, multimodal (text + image), extended thinking
- `nova-2-pro-v1` - 1M context, 65k output, multimodal (text + image)

## Setup

Set the `NOVA_API_KEY` environment variable:

```bash
export NOVA_API_KEY="your-api-key"
```

Or use the onboarding flow:

```bash
openclaw onboard --auth-choice amazon-nova-api-key
```

## Usage

```bash
openclaw agent --model amazon-nova/nova-2-lite-v1
```

## Extended Thinking

Nova 2 Lite supports extended reasoning via the `reasoning_effort` parameter. Configure it
in your model params:

```json5
{
  agents: {
    defaults: {
      model: { primary: "amazon-nova/nova-2-lite-v1" },
      models: {
        "amazon-nova/nova-2-lite-v1": {
          alias: "Nova 2 Lite",
          params: {
            reasoning_effort: "high", // "disabled", "low", "medium", "high"
          },
        },
      },
    },
  },
}
```

| Level | Behavior |
|-------|----------|
| `disabled` | No extended thinking |
| `low` | Fast, basic reasoning |
| `medium` | Balanced reasoning and speed |
| `high` | Deep, thorough analysis |

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
            maxTokens: 65536,
          },
          {
            id: "nova-2-pro-v1",
            name: "Amazon Nova 2 Pro",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

## Testing the API directly

```bash
curl -L 'https://api.nova.amazon.com/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $NOVA_API_KEY' \
  -d '{
    "model": "nova-2-lite-v1",
    "messages": [
      {
        "role": "user",
        "content": "Hello! How are you?"
      }
    ]
  }'
```

## Notes

- The `Accept-Encoding: identity` header is required by the Nova API to disable compression.
- This provider is separate from Amazon Bedrock. For Bedrock-hosted Nova models, use the `amazon-bedrock` provider.
- Model refs use `amazon-nova/<modelId>` format.
