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
- If you use profiles, set `AWS_PROFILE` on the gateway host.
- Clawdbot surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,
  then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the
  default AWS SDK chain.
- Reasoning support depends on the model; check the Bedrock model card for
  current capabilities.
- If you prefer a managed key flow, you can also place an OpenAI‑compatible
  proxy in front of Bedrock and configure it as an OpenAI provider instead.
