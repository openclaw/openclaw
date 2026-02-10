---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Amazon Bedrock (Converse API) models with OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Amazon Bedrock models with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need AWS credential/region setup for model calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Amazon Bedrock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Amazon Bedrock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use **Amazon Bedrock** models via pi‑ai’s **Bedrock Converse**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
not an API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What pi‑ai supports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `amazon-bedrock`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API: `bedrock-converse-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: AWS credentials (env vars, shared config, or instance role)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Region: `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Automatic model discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If AWS credentials are detected, OpenClaw can automatically discover Bedrock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
models that support **streaming** and **text output**. Discovery uses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`bedrock:ListFoundationModels` and is cached (default: 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config options live under `models.bedrockDiscovery`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bedrockDiscovery: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      region: "us-east-1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      providerFilter: ["anthropic", "amazon"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      refreshInterval: 3600,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      defaultContextWindow: 32000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      defaultMaxTokens: 4096,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled` defaults to `true` when AWS credentials are present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `region` defaults to `AWS_REGION` or `AWS_DEFAULT_REGION`, then `us-east-1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `providerFilter` matches Bedrock provider names (for example `anthropic`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `refreshInterval` is seconds; set to `0` to disable caching.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `defaultContextWindow` (default: `32000`) and `defaultMaxTokens` (default: `4096`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  are used for discovered models (override if you know your model limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (manual)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure AWS credentials are available on the **gateway host**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_ACCESS_KEY_ID="AKIA..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_SECRET_ACCESS_KEY="..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_REGION="us-east-1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_SESSION_TOKEN="..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_PROFILE="your-profile"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional (Bedrock API key/bearer token):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_BEARER_TOKEN_BEDROCK="..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Add a Bedrock provider and model to your config (no `apiKey` required):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "amazon-bedrock": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "bedrock-converse-stream",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        auth: "aws-sdk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "us.anthropic.claude-opus-4-6-v1:0",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Claude Opus 4.6 (Bedrock)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text", "image"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## EC2 Instance Roles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When running OpenClaw on an EC2 instance with an IAM role attached, the AWS SDK（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
will automatically use the instance metadata service (IMDS) for authentication.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
However, OpenClaw's credential detection currently only checks for environment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
variables, not IMDS credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Workaround:** Set `AWS_PROFILE=default` to signal that AWS credentials are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
available. The actual authentication still uses the instance role via IMDS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add to ~/.bashrc or your shell profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_PROFILE=default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export AWS_REGION=us-east-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Required IAM permissions** for the EC2 instance role:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bedrock:InvokeModel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bedrock:InvokeModelWithResponseStream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bedrock:ListFoundationModels` (for automatic discovery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or attach the managed policy `AmazonBedrockFullAccess`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Quick setup:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1. Create IAM role and instance profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
aws iam create-role --role-name EC2-Bedrock-Access \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --assume-role-policy-document '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "Version": "2012-10-17",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "Statement": [{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Effect": "Allow",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Principal": {"Service": "ec2.amazonaws.com"},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Action": "sts:AssumeRole"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
aws iam attach-role-policy --role-name EC2-Bedrock-Access \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
aws iam create-instance-profile --instance-profile-name EC2-Bedrock-Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
aws iam add-role-to-instance-profile \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --instance-profile-name EC2-Bedrock-Access \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --role-name EC2-Bedrock-Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 2. Attach to your EC2 instance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
aws ec2 associate-iam-instance-profile \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --instance-id i-xxxxx \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --iam-instance-profile Name=EC2-Bedrock-Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 3. On the EC2 instance, enable discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set models.bedrockDiscovery.enabled true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set models.bedrockDiscovery.region us-east-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 4. Set the workaround env vars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'export AWS_PROFILE=default' >> ~/.bashrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source ~/.bashrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 5. Verify models are discovered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bedrock requires **model access** enabled in your AWS account/region.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automatic discovery needs the `bedrock:ListFoundationModels` permission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use profiles, set `AWS_PROFILE` on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  default AWS SDK chain.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reasoning support depends on the model; check the Bedrock model card for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  current capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you prefer a managed key flow, you can also place an OpenAI‑compatible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  proxy in front of Bedrock and configure it as an OpenAI provider instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
