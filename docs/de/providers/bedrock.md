---
summary: "„Verwenden Sie Amazon-Bedrock-Modelle (Converse API) mit OpenClaw“"
read_when:
  - Sie möchten Amazon-Bedrock-Modelle mit OpenClaw verwenden
  - Sie benötigen die Einrichtung von AWS-Anmeldeinformationen/Regionen für Modellaufrufe
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw kann **Amazon Bedrock**-Modelle über den **Bedrock Converse**-Streaming-Anbieter von pi‑ai verwenden. Die Bedrock-Authentifizierung nutzt die **Standard-Anmeldeinformationskette des AWS SDK** und keinen API-Schlüssel.

## Was pi‑ai unterstützt

- Anbieter: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS-Anmeldeinformationen (Umgebungsvariablen, gemeinsame Konfiguration oder Instanzrolle)
- Region: `AWS_REGION` oder `AWS_DEFAULT_REGION` (Standard: `us-east-1`)

## Automatische Modellerkennung

Wenn AWS-Anmeldeinformationen erkannt werden, kann OpenClaw automatisch Bedrock-Modelle ermitteln, die **Streaming** und **Textausgabe** unterstützen. Die Erkennung verwendet `bedrock:ListFoundationModels` und wird zwischengespeichert (Standard: 1 Stunde).

Konfigurationsoptionen befinden sich unter `models.bedrockDiscovery`:

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

Hinweise:

- `enabled` ist standardmäßig `true`, wenn AWS-Anmeldeinformationen vorhanden sind.
- `region` ist standardmäßig `AWS_REGION` oder `AWS_DEFAULT_REGION`, danach `us-east-1`.
- `providerFilter` entspricht den Bedrock-Anbieternamen (zum Beispiel `anthropic`).
- `refreshInterval` ist in Sekunden; setzen Sie `0`, um das Caching zu deaktivieren.
- `defaultContextWindow` (Standard: `32000`) und `defaultMaxTokens` (Standard: `4096`)
  werden für erkannte Modelle verwendet (überschreiben Sie diese, wenn Sie Ihre Modellgrenzen kennen).

## Setup (manuell)

1. Stellen Sie sicher, dass AWS-Anmeldeinformationen auf dem **Gateway-Host** verfügbar sind:

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

2. Fügen Sie Ihrer Konfiguration einen Bedrock-Anbieter und ein Modell hinzu (kein `apiKey` erforderlich):

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

## EC2-Instanzrollen

Wenn OpenClaw auf einer EC2-Instanz mit angehängter IAM-Rolle ausgeführt wird, verwendet das AWS SDK automatisch den Instance Metadata Service (IMDS) zur Authentifizierung.
Die Anmeldeinformations-Erkennung von OpenClaw prüft derzeit jedoch nur Umgebungsvariablen und nicht IMDS-Anmeldeinformationen.

**Workaround:** Setzen Sie `AWS_PROFILE=default`, um zu signalisieren, dass AWS-Anmeldeinformationen verfügbar sind. Die tatsächliche Authentifizierung verwendet weiterhin die Instanzrolle über IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Erforderliche IAM-Berechtigungen** für die EC2-Instanzrolle:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (für die automatische Erkennung)

Oder hängen Sie die verwaltete Richtlinie `AmazonBedrockFullAccess` an.

**Schnelleinrichtung:**

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

## Hinweise

- Bedrock erfordert aktivierten **Modellzugriff** in Ihrem AWS-Konto/Ihrer Region.
- Die automatische Erkennung benötigt die Berechtigung `bedrock:ListFoundationModels`.
- Wenn Sie Profile verwenden, setzen Sie `AWS_PROFILE` auf dem Gateway-Host.
- OpenClaw zeigt die Quelle der Anmeldeinformationen in dieser Reihenfolge an: `AWS_BEARER_TOKEN_BEDROCK`,
  dann `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, dann `AWS_PROFILE`, anschließend die
  Standardkette des AWS SDK.
- Die Unterstützung von Reasoning hängt vom Modell ab; prüfen Sie die Bedrock-Modellkarte auf
  aktuelle Fähigkeiten.
- Wenn Sie einen verwalteten Schlüsselablauf bevorzugen, können Sie auch einen OpenAI‑kompatiblen
  Proxy vor Bedrock platzieren und ihn stattdessen als OpenAI-Anbieter konfigurieren.
