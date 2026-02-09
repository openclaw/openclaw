---
summary: "استخدام نماذج Amazon Bedrock (واجهة Converse API) مع OpenClaw"
read_when:
  - تريد استخدام نماذج Amazon Bedrock مع OpenClaw
  - تحتاج إلى إعداد بيانات اعتماد AWS/المنطقة لاستدعاءات النماذج
title: "Amazon Bedrock"
---

# Amazon Bedrock

يمكن لـ OpenClaw استخدام نماذج **Amazon Bedrock** عبر موفّر البثّ **Bedrock Converse**
من pi‑ai. تستخدم مصادقة Bedrock **سلسلة بيانات الاعتماد الافتراضية لـ AWS SDK**،
وليس مفتاح API.

## ما الذي يدعمه pi‑ai

- الموفّر: `amazon-bedrock`
- واجهة API: `bedrock-converse-stream`
- المصادقة: بيانات اعتماد AWS (متغيرات البيئة، التهيئة المشتركة، أو دور المثيل)
- المنطقة: `AWS_REGION` أو `AWS_DEFAULT_REGION` (الافتراضي: `us-east-1`)

## الاكتشاف التلقائي للنماذج

إذا تم اكتشاف بيانات اعتماد AWS، يمكن لـ OpenClaw اكتشاف نماذج Bedrock تلقائيًا
التي تدعم **البثّ** و**مخرجات النص**. يستخدم الاكتشاف
`bedrock:ListFoundationModels` ويتم تخزينه مؤقتًا (الافتراضي: ساعة واحدة).

توجد خيارات التهيئة ضمن `models.bedrockDiscovery`:

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

ملاحظات:

- القيمة الافتراضية لـ `enabled` هي `true` عند توفر بيانات اعتماد AWS.
- القيمة الافتراضية لـ `region` هي `AWS_REGION` أو `AWS_DEFAULT_REGION`، ثم `us-east-1`.
- يطابق `providerFilter` أسماء موفّري Bedrock (على سبيل المثال `anthropic`).
- `refreshInterval` بالثواني؛ اضبطه على `0` لتعطيل التخزين المؤقت.
- يتم استخدام `defaultContextWindow` (الافتراضي: `32000`) و`defaultMaxTokens` (الافتراضي: `4096`)
  للنماذج المكتشفة (يمكن التجاوز إذا كنت تعرف حدود نموذجك).

## الإعداد (يدوي)

1. تأكد من توفر بيانات اعتماد AWS على **مضيف Gateway**:

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

2. أضف موفّر Bedrock ونموذجًا إلى التهيئة لديك (لا يلزم `apiKey`):

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

## أدوار مثيلات EC2

عند تشغيل OpenClaw على مثيل EC2 مع إرفاق دور IAM، سيستخدم AWS SDK تلقائيًا خدمة
بيانات تعريف المثيل (IMDS) للمصادقة.
ومع ذلك، فإن اكتشاف بيانات الاعتماد في
OpenClaw يتحقق حاليًا من متغيرات البيئة فقط، وليس من بيانات اعتماد IMDS.

**حل بديل:** عيّن `AWS_PROFILE=default` للإشارة إلى أن بيانات اعتماد AWS متاحة. تستمر المصادقة الفعلية في استخدام دور المثيل عبر IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**أذونات IAM المطلوبة** لدور مثيل EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (للاكتشاف التلقائي)

أو قم بإرفاق السياسة المُدارة `AmazonBedrockFullAccess`.

**إعداد سريع:**

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

## ملاحظات

- يتطلب Bedrock تمكين **الوصول إلى النماذج** في حساب AWS/المنطقة لديك.
- يحتاج الاكتشاف التلقائي إلى إذن `bedrock:ListFoundationModels`.
- إذا كنت تستخدم ملفات تعريف، فاضبط `AWS_PROFILE` على مضيف Gateway.
- يعرض OpenClaw مصدر بيانات الاعتماد بهذا الترتيب: `AWS_BEARER_TOKEN_BEDROCK`،
  ثم `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`، ثم `AWS_PROFILE`، ثم
  سلسلة AWS SDK الافتراضية.
- يعتمد دعم الاستدلال المنطقي على النموذج؛ راجع بطاقة نموذج Bedrock للاطلاع على
  الإمكانات الحالية.
- إذا كنت تفضّل تدفّق مفاتيح مُدارًا، يمكنك أيضًا وضع وكيل متوافق مع OpenAI أمام
  Bedrock وتهيئته كمزوّد OpenAI بدلًا من ذلك.
