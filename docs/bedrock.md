---
summary: "Use Amazon Bedrock (Converse API) models with OpenClaw"
read_when:
  - You want to use Amazon Bedrock models with OpenClaw
  - You need AWS credential/region setup for model calls
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw can use **Amazon Bedrock** models via pi‑ai’s **Bedrock Converse**
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

## What pi‑ai supports

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS credentials (env vars, shared config, or instance role)
- Region: `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`)

## Automatic model discovery

If AWS credentials are detected, OpenClaw can automatically discover Bedrock
models that support **streaming** and **text output**. Discovery uses
`bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` APIs and is
cached (default: 1 hour).

By default, OpenClaw discovers both:

- **Foundation models** (region-specific, e.g., `anthropic.claude-3-haiku-20240307-v1:0`)
- **Inference profiles** (cross-region, e.g., `us.anthropic.claude-3-haiku-20240307-v1:0`)

Inference profiles enable **cross-region inference**, which automatically routes
requests across multiple AWS regions for better availability and performance.

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
      defaultMaxTokens: 4096,
      includeInferenceProfiles: true,
    },
  },
}
```

Notes:

- `enabled` defaults to `true` when AWS credentials are present.
- `region` defaults to `AWS_REGION` or `AWS_DEFAULT_REGION`, then `us-east-1`.
- `providerFilter` matches Bedrock provider names (for example `anthropic`).
- `refreshInterval` is seconds; set to `0` to disable caching.
- `defaultContextWindow` (default: `32000`) and `defaultMaxTokens` (default: `4096`)
  are used for discovered models (override if you know your model limits).
- `includeInferenceProfiles` (default: `true`) includes cross-region inference
  profiles. Set to `false` to discover only region-specific foundation models.

## Setup (manual)

1. Ensure AWS credentials are available on the **gateway host**:

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

2. Add a Bedrock provider and model to your config (no `apiKey` required):

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
            id: "us.anthropic.claude-opus-4-6-v1:0",
            name: "Claude Opus 4.6 (Bedrock)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },
    },
  },
}
```

## EC2 Instance Roles

When running OpenClaw on an EC2 instance with an IAM role attached, the AWS SDK
will automatically use the instance metadata service (IMDS) for authentication.
However, OpenClaw's credential detection currently only checks for environment
variables, not IMDS credentials.

**Workaround:** Set `AWS_PROFILE=default` to signal that AWS credentials are
available. The actual authentication still uses the instance role via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Required IAM permissions** for the EC2 instance role:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (for automatic discovery)
- `bedrock:ListInferenceProfiles` (for cross-region inference profile discovery)

Or attach the managed policy `AmazonBedrockFullAccess`.

**Quick setup:**

```bash
# 1. Create IAM role and instance profile
aws iam create-role --role-name EC2-Bedrock-Access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name EC2-Bedrock-Access \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam create-instance-profile --instance-profile-name EC2-Bedrock-Access
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2-Bedrock-Access \
  --role-name EC2-Bedrock-Access

# 2. Attach to your EC2 instance
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. On the EC2 instance, enable discovery
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. Set the workaround env vars
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verify models are discovered
openclaw models list
```

## Foundation Models vs Inference Profiles

AWS Bedrock provides two ways to access models:

### Foundation Models (Region-Specific)

- Model ID format: `anthropic.claude-3-haiku-20240307-v1:0`
- Tied to a single AWS region
- Requests are processed in that specific region only
- Lower latency if you're in the same region
- May experience capacity issues during high demand

### Inference Profiles (Cross-Region)

- Model ID format: `us.anthropic.claude-3-haiku-20240307-v1:0` (US regions)
- Model ID format: `eu.anthropic.claude-3-haiku-20240307-v1:0` (EU regions)
- Model ID format: `global.anthropic.claude-opus-4-6-v1` (all commercial regions)
- Automatically routes requests across multiple AWS regions
- Better availability and resilience during traffic bursts
- Slightly higher latency due to cross-region routing
- Recommended for production workloads

**When to use inference profiles:**

- Production applications requiring high availability
- Workloads with unpredictable traffic patterns
- Applications that need to handle traffic bursts
- When you want automatic failover across regions
- **Required for some models** (e.g., Claude Opus 4.6, Amazon Nova 2)

**When to use foundation models:**

- Development and testing
- Latency-sensitive applications in a single region
- When you have specific regional compliance requirements
- Cost optimization (no cross-region data transfer)
- Only available for models without inference profiles

### Smart Deduplication

When `includeInferenceProfiles` is enabled (default), OpenClaw automatically
prevents duplicate model IDs by using this logic:

- If a model has **both** a foundation model ID and an inference profile ID,
  only the **inference profile** is included in discovery
- If a model has **only** a foundation model ID (no inference profile),
  the foundation model is included

This prevents errors like:

```
Invocation of model ID amazon.nova-2-lite-v1:0 with on-demand throughput isn't supported.
Retry your request with the ID or ARN of an inference profile that contains this model.
```

**Example:** For Claude 3 Haiku:

- Foundation model: `anthropic.claude-3-haiku-20240307-v1:0` (skipped)
- Inference profile: `us.anthropic.claude-3-haiku-20240307-v1:0` (included)

**Example:** For a model without an inference profile:

- Foundation model: `cohere.command-r-v1:0` (included)
- No inference profile available

This ensures you always get working model IDs while maintaining access to all
available models.

## Notes

- Bedrock requires **model access** enabled in your AWS account/region.
- Automatic discovery needs the `bedrock:ListFoundationModels` and
  `bedrock:ListInferenceProfiles` permissions.
- If you use profiles, set `AWS_PROFILE` on the gateway host.
- OpenClaw surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,
  then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the
  default AWS SDK chain.
- Reasoning support depends on the model; check the Bedrock model card for
  current capabilities.
- Cross-region inference profiles (with `us.`, `eu.`, or `global.` prefix) are
  recommended for production use due to better availability.
- If you prefer a managed key flow, you can also place an OpenAI‑compatible
  proxy in front of Bedrock and configure it as an OpenAI provider instead.
