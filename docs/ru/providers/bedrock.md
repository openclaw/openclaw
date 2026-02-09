---
summary: "Используйте модели Amazon Bedrock (Converse API) с OpenClaw"
read_when:
  - Вы хотите использовать модели Amazon Bedrock с OpenClaw
  - Вам требуется настройка AWS‑учётных данных и региона для вызовов моделей
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw может использовать модели **Amazon Bedrock** через потокового провайдера
**Bedrock Converse** от pi‑ai. Аутентификация Bedrock использует **цепочку учётных
данных AWS SDK по умолчанию**, а не ключ API.

## Что поддерживает pi‑ai

- Провайдер: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Аутентификация: учётные данные AWS (переменные окружения, общий конфиг или роль инстанса)
- Регион: `AWS_REGION` или `AWS_DEFAULT_REGION` (по умолчанию: `us-east-1`)

## Автоматическое обнаружение моделей

Если обнаружены учётные данные AWS, OpenClaw может автоматически находить модели
Bedrock, которые поддерживают **потоковую передачу** и **текстовый вывод**. Обнаружение использует `bedrock:ListFoundationModels` и кэшируется (по умолчанию: 1 час).

Параметры конфигурации находятся в разделе `models.bedrockDiscovery`:

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

Примечания:

- `enabled` по умолчанию равен `true`, если присутствуют учётные данные AWS.
- `region` по умолчанию равен `AWS_REGION` или `AWS_DEFAULT_REGION`, затем `us-east-1`.
- `providerFilter` соответствует именам провайдеров Bedrock (например, `anthropic`).
- `refreshInterval` указывается в секундах; установите `0`, чтобы отключить кэширование.
- `defaultContextWindow` (по умолчанию: `32000`) и `defaultMaxTokens` (по умолчанию: `4096`)
  используются для обнаруженных моделей (переопределите, если вы знаете ограничения своей модели).

## Настройка (вручную)

1. Убедитесь, что учётные данные AWS доступны на **хосте шлюза Gateway**:

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

2. Добавьте провайдер Bedrock и модель в конфиг (ключ `apiKey` не требуется):

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

## Роли инстансов EC2

При запуске OpenClaw на инстансе EC2 с прикреплённой IAM‑ролью AWS SDK автоматически
использует службу метаданных инстанса (IMDS) для аутентификации.
Однако текущая
проверка учётных данных в OpenClaw учитывает только переменные окружения, а не
учётные данные IMDS.

**Обходной путь:** установите `AWS_PROFILE=default`, чтобы сигнализировать о наличии
учётных данных AWS. Фактическая аутентификация по‑прежнему будет выполняться через
роль инстанса с использованием IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Требуемые IAM‑права** для роли инстанса EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (для автоматического обнаружения)

Или подключите управляемую политику `AmazonBedrockFullAccess`.

**Быстрая настройка:**

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

## Примечания

- Bedrock требует включённого **доступа к моделям** в вашей учётной записи AWS и регионе.
- Для автоматического обнаружения требуется право `bedrock:ListFoundationModels`.
- Если вы используете профили, установите `AWS_PROFILE` на хосте шлюза Gateway.
- OpenClaw отображает источник учётных данных в следующем порядке: `AWS_BEARER_TOKEN_BEDROCK`,
  затем `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, затем `AWS_PROFILE`, затем цепочка
  AWS SDK по умолчанию.
- Поддержка рассуждений зависит от модели; проверьте карточку модели Bedrock для
  актуальных возможностей.
- Если вы предпочитаете управляемый поток с ключами, вы также можете разместить
  OpenAI‑совместимый прокси перед Bedrock и настроить его как провайдера OpenAI.
