---
summary: "Använd Amazon Bedrock‑modeller (Converse API) med OpenClaw"
read_when:
  - Du vill använda Amazon Bedrock‑modeller med OpenClaw
  - Du behöver konfigurera AWS‑autentisering/region för modellanrop
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw kan använda **Amazon Bedrock** modeller via pi‐ais **Bedrock Converse**
streamingleverantör. Bedrock auth använder **AWS SDK standard autentiseringskedjan**,
inte en API-nyckel.

## Vad pi‑ai stöder

- Leverantör: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Autentisering: AWS‑autentiseringsuppgifter (miljövariabler, delad konfig eller instansroll)
- Region: `AWS_REGION` eller `AWS_DEFAULT_REGION` (standard: `us-east-1`)

## Automatisk modellupptäckt

Om AWS autentiseringsuppgifter upptäcks kan OpenClaw automatiskt upptäcka Bedrock
modeller som stöder **strömning** och **textutgång**. Discovery använder
`bedrock:ListFoundationModels` och cachas (standard: 1 timme).

Konfigalternativ finns under `models.bedrockDiscovery`:

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

Noteringar:

- `enabled` är som standard `true` när AWS‑autentiseringsuppgifter finns.
- `region` är som standard `AWS_REGION` eller `AWS_DEFAULT_REGION`, därefter `us-east-1`.
- `providerFilter` matchar Bedrock‑leverantörsnamn (till exempel `anthropic`).
- `refreshInterval` är sekunder; sätt till `0` för att inaktivera cache.
- `defaultContextWindow` (standard: `32000`) och `defaultMaxTokens` (standard: `4096`)
  används för upptäckta modeller (åsidosätt om du känner till modellens gränser).

## Konfigurering (manuell)

1. Säkerställ att AWS‑autentiseringsuppgifter finns tillgängliga på **gateway‑värden**:

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

2. Lägg till en Bedrock‑leverantör och modell i din konfig (ingen `apiKey` krävs):

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

## EC2‑instansroller

När du kör OpenClaw på en EC2-instans med en IAM-roll bifogad, AWS SDK
kommer automatiskt att använda instans metadatatjänst (IMDS) för autentisering.
OpenClaws autentiseringskontroller kontrollerar för närvarande bara om omgivningen
-variabler, inte IMDS-autentiseringsuppgifter.

**Lösning:** Ange `AWS_PROFILE=default` att signalera att AWS autentiseringsuppgifter är
tillgängliga. Själva autentiseringen använder fortfarande instansrollen via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Nödvändiga IAM‑behörigheter** för EC2‑instansrollen:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (för automatisk upptäckt)

Eller koppla den hanterade policyn `AmazonBedrockFullAccess`.

**Snabb konfiguration:**

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

## Noteringar

- Bedrock kräver att **modellåtkomst** är aktiverad i ditt AWS‑konto/region.
- Automatisk upptäckt kräver behörigheten `bedrock:ListFoundationModels`.
- Om du använder profiler, sätt `AWS_PROFILE` på gateway‑värden.
- OpenClaw exponerar källan för autentiseringsuppgifter i denna ordning: `AWS_BEARER_TOKEN_BEDROCK`,
  därefter `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, därefter `AWS_PROFILE`, och sedan
  AWS SDK:s standardkedja.
- Stöd för resonemang beror på modellen; kontrollera Bedrock‑modellkortet för
  aktuella funktioner.
- Om du föredrar ett hanterat nyckelflöde kan du även placera en OpenAI‑kompatibel
  proxy framför Bedrock och konfigurera den som en OpenAI‑leverantör i stället.
