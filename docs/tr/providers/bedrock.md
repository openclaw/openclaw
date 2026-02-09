---
summary: "OpenClaw ile Amazon Bedrock (Converse API) modellerini kullanın"
read_when:
  - OpenClaw ile Amazon Bedrock modellerini kullanmak istiyorsunuz
  - Model çağrıları için AWS kimlik bilgileri/bölge kurulumuna ihtiyacınız var
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw, pi‑ai’nin **Bedrock Converse** akış sağlayıcısı üzerinden **Amazon Bedrock**
modellerini kullanabilir. Bedrock kimlik doğrulaması, bir API anahtarı değil,
**AWS SDK varsayılan kimlik bilgisi zincirini** kullanır.

## pi‑ai neleri destekler

- Sağlayıcı: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Kimlik doğrulama: AWS kimlik bilgileri (ortam değişkenleri, paylaşılan yapılandırma veya instance rolü)
- Bölge: `AWS_REGION` veya `AWS_DEFAULT_REGION` (varsayılan: `us-east-1`)

## Otomatik model keşfi

AWS kimlik bilgileri algılanırsa, OpenClaw **akış** ve **metin çıktısı** destekleyen
Bedrock modellerini otomatik olarak keşfedebilir. Keşif, `bedrock:ListFoundationModels` kullanır
ve önbelleğe alınır (varsayılan: 1 saat).

Yapılandırma seçenekleri `models.bedrockDiscovery` altında yer alır:

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

Notlar:

- `enabled`, AWS kimlik bilgileri mevcut olduğunda varsayılan olarak `true` olur.
- `region`, varsayılan olarak `AWS_REGION` veya `AWS_DEFAULT_REGION`, ardından `us-east-1` olur.
- `providerFilter`, Bedrock sağlayıcı adlarıyla eşleşir (örneğin `anthropic`).
- `refreshInterval` saniye cinsindendir; önbelleği devre dışı bırakmak için `0` olarak ayarlayın.
- `defaultContextWindow` (varsayılan: `32000`) ve `defaultMaxTokens` (varsayılan: `4096`)
  keşfedilen modeller için kullanılır (model sınırlarınızı biliyorsanız geçersiz kılın).

## Kurulum (manuel)

1. **Gateway ana makinesi** üzerinde AWS kimlik bilgilerinin mevcut olduğundan emin olun:

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

2. Yapılandırmanıza bir Bedrock sağlayıcısı ve modeli ekleyin (`apiKey` gerekmez):

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

## EC2 Instance Rolleri

OpenClaw, iliştirilmiş bir IAM rolü olan bir EC2 instance üzerinde çalıştığında, AWS SDK
kimlik doğrulama için otomatik olarak instance metadata service’i (IMDS) kullanır.
Ancak OpenClaw’ın kimlik bilgisi algılaması şu anda yalnızca ortam değişkenlerini
kontrol eder; IMDS kimlik bilgilerini kontrol etmez.

**Geçici çözüm:** AWS kimlik bilgilerinin mevcut olduğunu belirtmek için `AWS_PROFILE=default` ayarlayın. Gerçek kimlik doğrulama yine IMDS üzerinden instance rolünü kullanır.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 instance rolü için **gerekli IAM izinleri**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (otomatik keşif için)

Ya da yönetilen ilkeyi `AmazonBedrockFullAccess` ekleyin.

**Hızlı kurulum:**

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

## Notlar

- Bedrock, AWS hesabınızda/bölgenizde **model erişiminin** etkinleştirilmesini gerektirir.
- Otomatik keşif için `bedrock:ListFoundationModels` izni gerekir.
- Profiller kullanıyorsanız, gateway ana makinesinde `AWS_PROFILE` ayarlayın.
- OpenClaw, kimlik bilgisi kaynağını şu sırayla gösterir: `AWS_BEARER_TOKEN_BEDROCK`,
  ardından `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, sonra `AWS_PROFILE`, ardından
  varsayılan AWS SDK zinciri.
- Akıl yürütme desteği modele bağlıdır; güncel yetenekler için Bedrock model kartını kontrol edin.
- Yönetilen bir anahtar akışını tercih ederseniz, Bedrock’un önüne OpenAI‑uyumlu
  bir proxy koyabilir ve bunu bir OpenAI sağlayıcısı olarak yapılandırabilirsiniz.
