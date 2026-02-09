---
summary: "Brug Amazon Bedrock (Converse API)-modeller med OpenClaw"
read_when:
  - Du vil bruge Amazon Bedrock-modeller med OpenClaw
  - Du har brug for opsætning af AWS-legitimationsoplysninger/region til modelkald
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw kan bruge **Amazon Bedrock** modeller via pi-ai’s **Bedrock Converse**
streamingudbyder. Bedrock auth bruger \*\* AWS SDK standard legitimationsoplysninger kæde \*\*,
ikke en API-nøgle.

## Hvad pi‑ai understøtter

- Udbyder: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Autentificering: AWS-legitimationsoplysninger (miljøvariabler, delt konfiguration eller instansrolle)
- Region: `AWS_REGION` eller `AWS_DEFAULT_REGION` (standard: `us-east-1`)

## Automatisk modeldiscovery

Hvis AWS legitimationsoplysninger registreres, kan OpenClaw automatisk opdage Bedrock
modeller, der understøtter **streaming** og **tekst output**. Discovery bruger
`bedrock:ListFoundationModels` og caches (standard: 1 time).

Konfigurationsindstillinger findes under `models.bedrockDiscovery`:

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

Noter:

- `enabled` er som standard `true`, når AWS-legitimationsoplysninger er til stede.
- `region` er som standard `AWS_REGION` eller `AWS_DEFAULT_REGION`, derefter `us-east-1`.
- `providerFilter` matcher Bedrock-udbydernavne (for eksempel `anthropic`).
- `refreshInterval` er sekunder; sæt til `0` for at deaktivere caching.
- `defaultContextWindow` (standard: `32000`) og `defaultMaxTokens` (standard: `4096`)
  bruges til opdagede modeller (tilsidesæt, hvis du kender dine modellimits).

## Opsætning (manuel)

1. Sørg for, at AWS-legitimationsoplysninger er tilgængelige på **gateway-værten**:

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

2. Tilføj en Bedrock-udbyder og -model til din konfiguration (ingen `apiKey` kræves):

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

## EC2-instansroller

Når du kører OpenClaw på en EC2 instans med en IAM rolle vedhæftet AWS SDK
vil automatisk bruge den instans metadata service (IMDS) til godkendelse.
Men OpenClaw's legitimationsoplysninger detektering i øjeblikket kun kontrollerer for miljø
variabler, ikke IMDS legitimationsoplysninger.

**Workaround:** Sæt `AWS_PROFILE=default` for at signalere, at AWS legitimationsoplysninger er
tilgængelige. Den faktiske autentificering bruger stadig instansrollen via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Påkrævede IAM-tilladelser** for EC2-instansrollen:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (til automatisk discovery)

Eller tilknyt den administrerede politik `AmazonBedrockFullAccess`.

**Hurtig opsætning:**

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

## Noter

- Bedrock kræver, at **modeladgang** er aktiveret i din AWS-konto/region.
- Automatisk discovery kræver tilladelsen `bedrock:ListFoundationModels`.
- Hvis du bruger profiler, skal du sætte `AWS_PROFILE` på gateway-værten.
- OpenClaw viser kilden til legitimationsoplysninger i denne rækkefølge: `AWS_BEARER_TOKEN_BEDROCK`,
  derefter `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, derefter `AWS_PROFILE`, og til sidst
  AWS SDK’s standardkæde.
- Understøttelse af ræsonnering afhænger af modellen; tjek Bedrock-modelkortet for
  aktuelle muligheder.
- Hvis du foretrækker et administreret nøgleflow, kan du også placere en OpenAI‑kompatibel
  proxy foran Bedrock og konfigurere den som en OpenAI-udbyder i stedet.
