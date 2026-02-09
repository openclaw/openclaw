---
summary: "Gumamit ng mga model ng Amazon Bedrock (Converse API) kasama ang OpenClaw"
read_when:
  - Gusto mong gumamit ng mga model ng Amazon Bedrock kasama ang OpenClaw
  - Kailangan mo ng setup ng AWS credential/region para sa mga tawag ng model
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw can use **Amazon Bedrock** models via pi‑ai’s **Bedrock Converse**
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

## Ano ang sinusuportahan ng pi‑ai

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS credentials (env vars, shared config, o instance role)
- Region: `AWS_REGION` o `AWS_DEFAULT_REGION` (default: `us-east-1`)

## Awtomatikong discovery ng model

If AWS credentials are detected, OpenClaw can automatically discover Bedrock
models that support **streaming** and **text output**. Discovery uses
`bedrock:ListFoundationModels` and is cached (default: 1 hour).

Matatagpuan ang mga opsyon ng config sa ilalim ng `models.bedrockDiscovery`:

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

Mga tala:

- Ang `enabled` ay default na `true` kapag may AWS credentials.
- Ang `region` ay default na `AWS_REGION` o `AWS_DEFAULT_REGION`, pagkatapos ay `us-east-1`.
- Ang `providerFilter` ay tumutugma sa mga pangalan ng Bedrock provider (halimbawa `anthropic`).
- Ang `refreshInterval` ay nasa segundo; itakda sa `0` para i-disable ang caching.
- Ang `defaultContextWindow` (default: `32000`) at `defaultMaxTokens` (default: `4096`)
  ay ginagamit para sa mga nadiskubreng model (i-override kung alam mo ang mga limit ng iyong model).

## Setup (manual)

1. Tiyaking available ang AWS credentials sa **host ng Gateway**:

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

2. Magdagdag ng Bedrock provider at model sa iyong config (walang `apiKey` na kailangan):

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

**Mga kinakailangang IAM permission** para sa EC2 instance role:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (para sa awtomatikong discovery)

O ikabit ang managed policy na `AmazonBedrockFullAccess`.

**Mabilis na setup:**

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

## Mga tala

- Nangangailangan ang Bedrock ng **model access** na naka-enable sa iyong AWS account/region.
- Kailangan ng awtomatikong discovery ang permission na `bedrock:ListFoundationModels`.
- Kung gumagamit ka ng mga profile, itakda ang `AWS_PROFILE` sa host ng Gateway.
- Ipinapakita ng OpenClaw ang pinanggalingan ng credential sa ganitong pagkakasunod-sunod: `AWS_BEARER_TOKEN_BEDROCK`,
  pagkatapos `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, pagkatapos `AWS_PROFILE`, at pagkatapos ay ang
  default na AWS SDK chain.
- Nakadepende ang support para sa reasoning sa model; tingnan ang Bedrock model card para sa
  kasalukuyang kakayahan.
- Kung mas gusto mo ang isang managed key flow, maaari ka ring maglagay ng OpenAI‑compatible
  proxy sa harap ng Bedrock at i-configure ito bilang isang OpenAI provider sa halip.
