---
summary: "Gebruik Amazon Bedrock (Converse API)-modellen met OpenClaw"
read_when:
  - Je wilt Amazon Bedrock-modellen gebruiken met OpenClaw
  - Je hebt AWS-referenties/regio-instellingen nodig voor modelaanroepen
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw kan **Amazon Bedrock**-modellen gebruiken via pi‑ai’s **Bedrock Converse**
streamingprovider. Bedrock-authenticatie gebruikt de **standaard AWS SDK‑credential chain**,
niet een API-sleutel.

## Wat pi‑ai ondersteunt

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS-referenties (omgevingsvariabelen, gedeelde config of instance role)
- Regio: `AWS_REGION` of `AWS_DEFAULT_REGION` (standaard: `us-east-1`)

## Automatische model discovery

Als AWS-referenties worden gedetecteerd, kan OpenClaw automatisch Bedrock-modellen
ontdekken die **streaming** en **tekstuitvoer** ondersteunen. Discovery gebruikt
`bedrock:ListFoundationModels` en wordt gecachet (standaard: 1 uur).

Config-opties staan onder `models.bedrockDiscovery`:

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

Notities:

- `enabled` staat standaard op `true` wanneer AWS-referenties aanwezig zijn.
- `region` staat standaard op `AWS_REGION` of `AWS_DEFAULT_REGION`, daarna `us-east-1`.
- `providerFilter` komt overeen met namen van Bedrock-providers (bijvoorbeeld `anthropic`).
- `refreshInterval` is in seconden; stel in op `0` om cachen uit te schakelen.
- `defaultContextWindow` (standaard: `32000`) en `defaultMaxTokens` (standaard: `4096`)
  worden gebruikt voor ontdekte modellen (overschrijf als je je modellimieten kent).

## Installatie (handmatig)

1. Zorg dat AWS-referenties beschikbaar zijn op de **Gateway-host**:

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

2. Voeg een Bedrock-provider en -model toe aan je config (geen `apiKey` vereist):

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

Wanneer OpenClaw draait op een EC2-instance met een gekoppelde IAM-rol, gebruikt de AWS SDK
automatisch de instance metadata service (IMDS) voor authenticatie.
De detectie van referenties in OpenClaw controleert momenteel echter alleen omgevingsvariabelen,
niet IMDS-referenties.

**Workaround:** Stel `AWS_PROFILE=default` in om aan te geven dat AWS-referenties beschikbaar zijn. De daadwerkelijke authenticatie gebruikt nog steeds de instance role via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Vereiste IAM-rechten** voor de EC2-instance role:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (voor automatische discovery)

Of koppel het beheerde beleid `AmazonBedrockFullAccess`.

**Snelle installatie:**

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

## Notities

- Bedrock vereist dat **modeltoegang** is ingeschakeld in je AWS-account/regio.
- Automatische discovery vereist de machtiging `bedrock:ListFoundationModels`.
- Als je profielen gebruikt, stel `AWS_PROFILE` in op de Gateway-host.
- OpenClaw toont de credentialbron in deze volgorde: `AWS_BEARER_TOKEN_BEDROCK`,
  daarna `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, daarna `AWS_PROFILE`, en vervolgens de
  standaard AWS SDK‑chain.
- Ondersteuning voor redeneren hangt af van het model; raadpleeg de Bedrock-modelkaart
  voor de huidige mogelijkheden.
- Als je de voorkeur geeft aan een beheerde sleutelstroom, kun je ook een OpenAI‑compatibele
  proxy vóór Bedrock plaatsen en deze in plaats daarvan configureren als een OpenAI-provider.
