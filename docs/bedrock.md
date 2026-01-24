---
summary: "Use Amazon Bedrock (Converse API) models with Clawdbot"
read_when:
  - You want to use Amazon Bedrock models with Clawdbot
  - You need AWS credential/region setup for model calls
---
# Amazon Bedrock

Clawdbot can use **Amazon Bedrock** models via pi‑ai’s **Bedrock Converse**
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

## What pi‑ai supports

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS credentials (env vars, shared config, or instance role)
- Region: `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`)

## Automatic model discovery

If AWS credentials are detected, Clawdbot can automatically discover Bedrock
models that support **streaming** and **text output**. Discovery uses
`bedrock:ListFoundationModels` and is cached (default: 1 hour).

Config options live under `models.bedrockDiscovery`:

```json5
{
  models: {
    bedrockDiscovery: {
      enabled: true,
      region: "us-east-1",
      providerFilter: ["anthropic", "amazon"],
      refreshInterval: 3600,
      defaultContextWindow: 32000,
      defaultMaxTokens: 4096
    }
  }
}
```

Notes:
- `enabled` defaults to `true` when AWS credentials are present.
- `region` defaults to `AWS_REGION` or `AWS_DEFAULT_REGION`, then `us-east-1`.
- `providerFilter` matches Bedrock provider names (for example `anthropic`).
- `refreshInterval` is seconds; set to `0` to disable caching.
- `defaultContextWindow` (default: `32000`) and `defaultMaxTokens` (default: `4096`)
  are used for discovered models (override if you know your model limits).

## Setup (manual)

1) Ensure AWS credentials are available on the **gateway host**:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# Optional:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# Optional (Bedrock API key/bearer token):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2) Add a Bedrock provider and model to your config (no `apiKey` required):

```json5
{
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [
          {
            id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            name: "Claude 3.7 Sonnet (Bedrock)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192
          }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "amazon-bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0" }
    }
  }
}
```

## Notes

- Bedrock requires **model access** enabled in your AWS account/region.
- Automatic discovery needs the `bedrock:ListFoundationModels` permission.
- If you use profiles, set `AWS_PROFILE` on the gateway host.
- Clawdbot surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,
  then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the
  default AWS SDK chain.
- Reasoning support depends on the model; check the Bedrock model card for
  current capabilities.
- If you prefer a managed key flow, you can also place an OpenAI‑compatible
  proxy in front of Bedrock and configure it as an OpenAI provider instead.
