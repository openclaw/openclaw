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

## What pi-ai supports

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS credentials (env vars, shared config, or instance role)
- Region: `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`)

## Automatic model discovery

OpenClaw can automatically discover Bedrock models that support **streaming**
and **text output**. Discovery uses `bedrock:ListFoundationModels` and is
cached (default: 1 hour).

How the implicit provider is enabled:

- If `models.bedrockDiscovery.enabled` is `true`, OpenClaw will try discovery
  even when no AWS env marker is present.
- If `models.bedrockDiscovery.enabled` is unset, OpenClaw only auto-adds the
  implicit Bedrock provider when it sees one of these AWS auth markers:
  `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID` +
  `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`.
- The actual Bedrock runtime auth path still uses the AWS SDK default chain, so
  shared config, SSO, and IMDS instance-role auth can work even when discovery
  needed `enabled: true` to opt in.

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
    },
  },
}
```

Notes:

- `enabled` defaults to auto mode. In auto mode, OpenClaw only enables the
  implicit Bedrock provider when it sees a supported AWS env marker.
- `region` defaults to `AWS_REGION` or `AWS_DEFAULT_REGION`, then `us-east-1`.
- `providerFilter` matches Bedrock provider names (for example `anthropic`).
- `refreshInterval` is seconds; set to `0` to disable caching.
- `defaultContextWindow` (default: `32000`) and `defaultMaxTokens` (default: `4096`)
  are used for discovered models (override if you know your model limits).

## Onboarding

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
can use the instance metadata service (IMDS) for authentication. For Bedrock
model discovery, OpenClaw only auto-enables the implicit provider from AWS env
markers unless you explicitly set `models.bedrockDiscovery.enabled: true`.

Recommended setup for IMDS-backed hosts:

- Set `models.bedrockDiscovery.enabled` to `true`.
- Set `models.bedrockDiscovery.region` (or export `AWS_REGION`).
- You do **not** need a fake API key.
- You only need `AWS_PROFILE=default` if you specifically want an env marker
  for auto mode or status surfaces.

```bash
# Recommended: explicit discovery enable + region
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# Optional: add an env marker if you want auto mode without explicit enable
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Required IAM permissions** for the EC2 instance role:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (for automatic discovery)

Or attach the managed policy `AmazonBedrockFullAccess`.

## Quick setup (AWS path)

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

# 3. On the EC2 instance, enable discovery explicitly
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. Optional: add an env marker if you want auto mode without explicit enable
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verify models are discovered
openclaw models list
```

## Notes

- Bedrock requires **model access** enabled in your AWS account/region.
- Automatic discovery needs the `bedrock:ListFoundationModels` permission.
- If you rely on auto mode, set one of the supported AWS auth env markers on the
  gateway host. If you prefer IMDS/shared-config auth without env markers, set
  `models.bedrockDiscovery.enabled: true`.
- OpenClaw surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,
  then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the
  default AWS SDK chain.
- Reasoning support depends on the model; check the Bedrock model card for
  current capabilities.
- If you prefer a managed key flow, you can also place an OpenAI‑compatible
  proxy in front of Bedrock and configure it as an OpenAI provider instead.

## Guardrails

You can apply [Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
to all Bedrock model invocations by adding a `guardrail` object to the
`amazon-bedrock` plugin config. Guardrails let you enforce content filtering,
topic denial, word filters, sensitive information filters, and contextual
grounding checks.

```json5
{
  plugins: {
    entries: {
      "amazon-bedrock": {
        config: {
          guardrail: {
            guardrailIdentifier: "abc123", // guardrail ID or full ARN
            guardrailVersion: "1", // version number or "DRAFT"
            streamProcessingMode: "sync", // optional: "sync" or "async"
            trace: "enabled", // optional: "enabled", "disabled", or "enabled_full"
          },
        },
      },
    },
  },
}
```

- `guardrailIdentifier` (required) accepts a guardrail ID (e.g. `abc123`) or a
  full ARN (e.g. `arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123`).
- `guardrailVersion` (required) specifies which published version to use, or
  `"DRAFT"` for the working draft.
- `streamProcessingMode` (optional) controls whether guardrail evaluation runs
  synchronously (`"sync"`) or asynchronously (`"async"`) during streaming. If
  omitted, Bedrock uses its default behavior.
- `trace` (optional) enables guardrail trace output in the API response. Set to
  `"enabled"` or `"enabled_full"` for debugging; omit or set `"disabled"` for
  production.

The IAM principal used by the gateway must have the `bedrock:ApplyGuardrail`
permission in addition to the standard invoke permissions.
