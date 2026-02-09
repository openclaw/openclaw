---
summary: "Używaj modeli Amazon Bedrock (Converse API) z OpenClaw"
read_when:
  - Chcesz używać modeli Amazon Bedrock z OpenClaw
  - Potrzebujesz konfiguracji poświadczeń/regionu AWS do wywołań modeli
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw może korzystać z modeli **Amazon Bedrock** za pośrednictwem dostawcy strumieniowego **Bedrock Converse** w pi‑ai. Uwierzytelnianie Bedrock używa **domyślnego łańcucha poświadczeń AWS SDK**, a nie klucza API.

## Co obsługuje pi‑ai

- Dostawca: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Uwierzytelnianie: poświadczenia AWS (zmienne środowiskowe, współdzielona konfiguracja lub rola instancji)
- Region: `AWS_REGION` lub `AWS_DEFAULT_REGION` (domyślnie: `us-east-1`)

## Automatyczne wykrywanie modeli

Jeśli zostaną wykryte poświadczenia AWS, OpenClaw może automatycznie wykrywać modele Bedrock obsługujące **strumieniowanie** i **wyjście tekstowe**. Wykrywanie używa `bedrock:ListFoundationModels` i jest buforowane (domyślnie: 1 godzina).

Opcje konfiguracji znajdują się pod `models.bedrockDiscovery`:

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

Uwagi:

- `enabled` domyślnie ma wartość `true`, gdy obecne są poświadczenia AWS.
- `region` domyślnie ma wartość `AWS_REGION` lub `AWS_DEFAULT_REGION`, a następnie `us-east-1`.
- `providerFilter` odpowiada nazwom dostawców Bedrock (na przykład `anthropic`).
- `refreshInterval` jest w sekundach; ustaw `0`, aby wyłączyć buforowanie.
- `defaultContextWindow` (domyślnie: `32000`) oraz `defaultMaxTokens` (domyślnie: `4096`)
  są używane dla wykrytych modeli (nadpisz, jeśli znasz limity swojego modelu).

## Konfiguracja (ręczna)

1. Upewnij się, że poświadczenia AWS są dostępne na **hoście gateway**:

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

2. Dodaj dostawcę Bedrock i model do swojej konfiguracji (nie jest wymagany `apiKey`):

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

## Role instancji EC2

Podczas uruchamiania OpenClaw na instancji EC2 z dołączoną rolą IAM, AWS SDK automatycznie użyje usługi metadanych instancji (IMDS) do uwierzytelniania.
Jednak wykrywanie poświadczeń w OpenClaw obecnie sprawdza tylko zmienne środowiskowe, a nie poświadczenia IMDS.

**Obejście:** Ustaw `AWS_PROFILE=default`, aby zasygnalizować, że poświadczenia AWS są dostępne. Faktyczne uwierzytelnianie nadal używa roli instancji przez IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Wymagane uprawnienia IAM** dla roli instancji EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (do automatycznego wykrywania)

Lub dołącz zarządzaną politykę `AmazonBedrockFullAccess`.

**Szybka konfiguracja:**

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

## Uwagi

- Bedrock wymaga włączonego **dostępu do modeli** w Twoim koncie/regionie AWS.
- Automatyczne wykrywanie wymaga uprawnienia `bedrock:ListFoundationModels`.
- Jeśli używasz profili, ustaw `AWS_PROFILE` na hoście gateway.
- OpenClaw prezentuje źródło poświadczeń w następującej kolejności: `AWS_BEARER_TOKEN_BEDROCK`,
  następnie `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, następnie `AWS_PROFILE`, a potem
  domyślny łańcuch AWS SDK.
- Obsługa rozumowania zależy od modelu; sprawdź kartę modelu Bedrock pod kątem
  aktualnych możliwości.
- Jeśli preferujesz zarządzany przepływ kluczy, możesz także umieścić przed Bedrock
  proxy kompatybilne z OpenAI i skonfigurować je zamiast tego jako dostawcę OpenAI.
