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
- `nova-2-lite-v1` - 300k context, multimodal (text + image)
- `nova-2-pro-v1` - 300k context, multimodal (text + image)

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

## Config snippet

```json5
{
  env: { NOVA_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      model: { primary: "amazon-nova/nova-2-lite-v1" },
      models: {
        "amazon-nova/nova-2-lite-v1": { alias: "Nova 2 Lite" },
        "amazon-nova/nova-2-pro-v1": { alias: "Nova 2 Pro" }
      }
    }
  },
  models: {
    mode: "merge",
    providers: {
      "amazon-nova": {
        baseUrl: "https://api.nova.amazon.com/v1",
        apiKey: "${NOVA_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "nova-2-lite-v1",
            name: "Amazon Nova 2 Lite",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 300000,
            maxTokens: 8192,
            headers: { "Accept-Encoding": "identity" }
          },
          {
            id: "nova-2-pro-v1",
            name: "Amazon Nova 2 Pro",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 300000,
            maxTokens: 8192,
            headers: { "Accept-Encoding": "identity" }
          }
        ]
      }
    }
  }
}
```

## Notes

- The `Accept-Encoding: identity` header is required by the Nova API to disable compression.
- This provider is separate from Amazon Bedrock. For Bedrock-hosted Nova models, use the `amazon-bedrock` provider.
- Model refs use `amazon-nova/<modelId>` format.
