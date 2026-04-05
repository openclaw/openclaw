---
summary: "Use Amazon Bedrock Mantle (OpenAI-compatible) models with OpenClaw"
read_when:
  - You want to use Bedrock Mantle hosted OSS models with OpenClaw
  - You need the Mantle OpenAI-compatible endpoint for GPT-OSS, Qwen, Kimi, or GLM
title: "Amazon Bedrock Mantle"
---

# Amazon Bedrock Mantle

OpenClaw includes a bundled **Amazon Bedrock Mantle** provider that connects to
the Mantle OpenAI-compatible endpoint. Mantle hosts open-source and
third-party models (GPT-OSS, Qwen, Kimi, GLM, and similar) through a standard
`/v1/chat/completions` surface backed by Bedrock infrastructure.

## What OpenClaw supports

- Provider: `amazon-bedrock-mantle`
- API: `openai-completions` (OpenAI-compatible)
- Auth: bearer token via `AWS_BEARER_TOKEN_BEDROCK`
- Region: `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`)

## Automatic model discovery

When `AWS_BEARER_TOKEN_BEDROCK` is set, OpenClaw automatically discovers
available Mantle models by querying the region's `/v1/models` endpoint.
Discovery results are cached for 1 hour.

Supported regions: `us-east-1`, `us-east-2`, `us-west-2`, `ap-northeast-1`,
`ap-south-1`, `ap-southeast-3`, `eu-central-1`, `eu-west-1`, `eu-west-2`,
`eu-south-1`, `eu-north-1`, `sa-east-1`.

## Onboarding

1. Set the bearer token on the **gateway host**:

```bash
export AWS_BEARER_TOKEN_BEDROCK="..."
# Optional (defaults to us-east-1):
export AWS_REGION="us-west-2"
```

2. Verify models are discovered:

```bash
openclaw models list
```

Discovered models appear under the `amazon-bedrock-mantle` provider. No
additional config is required unless you want to override defaults.

## Manual configuration

If you prefer explicit config instead of auto-discovery:

```json5
{
  models: {
    providers: {
      "amazon-bedrock-mantle": {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
        models: [
          {
            id: "gpt-oss-120b",
            name: "GPT-OSS 120B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

## Notes

- Mantle requires a bearer token today. Plain IAM credentials (instance roles,
  SSO, access keys) are not sufficient without a token.
- The bearer token is the same `AWS_BEARER_TOKEN_BEDROCK` used by the standard
  [Amazon Bedrock](/providers/bedrock) provider.
- Reasoning support is inferred from model IDs containing patterns like
  `thinking`, `reasoner`, or `gpt-oss-120b`.
- If the Mantle endpoint is unavailable or returns no models, the provider is
  silently skipped.
