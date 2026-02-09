---
summary: "OpenClaw کے ساتھ Amazon Bedrock (Converse API) ماڈلز استعمال کریں"
read_when:
  - آپ OpenClaw کے ساتھ Amazon Bedrock ماڈلز استعمال کرنا چاہتے ہیں
  - آپ کو ماڈل کالز کے لیے AWS اسناد/ریجن سیٹ اپ درکار ہے
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw، pi‑ai کے **Bedrock Converse** اسٹریمنگ فراہم کنندہ کے ذریعے **Amazon Bedrock** ماڈلز استعمال کر سکتا ہے۔ Bedrock کی توثیق **AWS SDK default credential chain** استعمال کرتی ہے،
API کی نہیں۔

## pi‑ai کیا سپورٹ کرتا ہے

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS اسناد (env vars، shared config، یا instance role)
- Region: `AWS_REGION` یا `AWS_DEFAULT_REGION` (بطورِ طے شدہ: `us-east-1`)

## خودکار ماڈل دریافت

اگر AWS اسناد کا پتا چل جائے تو OpenClaw خودکار طور پر ایسے Bedrock ماڈلز دریافت کر سکتا ہے جو **اسٹریمنگ** اور **متنی آؤٹ پٹ** کی حمایت کرتے ہوں۔ دریافت کے لیے
`bedrock:ListFoundationModels` استعمال ہوتا ہے اور یہ کیش کیا جاتا ہے (ڈیفالٹ: 1 گھنٹہ)۔

کنفیگ کے اختیارات `models.bedrockDiscovery` کے تحت موجود ہوتے ہیں:

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

نوٹس:

- `enabled` بطورِ طے شدہ `true` ہوتا ہے جب AWS اسناد موجود ہوں۔
- `region` بطورِ طے شدہ `AWS_REGION` یا `AWS_DEFAULT_REGION`، پھر `us-east-1` ہوتا ہے۔
- `providerFilter` Bedrock فراہم کنندہ کے ناموں سے میل کھاتا ہے (مثلاً `anthropic`)۔
- `refreshInterval` سیکنڈز میں ہے؛ کیشنگ غیر فعال کرنے کے لیے `0` سیٹ کریں۔
- `defaultContextWindow` (بطورِ طے شدہ: `32000`) اور `defaultMaxTokens` (بطورِ طے شدہ: `4096`)
  دریافت شدہ ماڈلز کے لیے استعمال ہوتے ہیں (اگر آپ کو اپنے ماڈل کی حدود معلوم ہوں تو اووررائیڈ کریں)۔

## سیٹ اپ (دستی)

1. یقینی بنائیں کہ **گیٹ وے ہوسٹ** پر AWS اسناد دستیاب ہوں:

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

2. اپنی کنفیگ میں Bedrock فراہم کنندہ اور ماڈل شامل کریں (`apiKey` درکار نہیں):

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

جب OpenClaw کو کسی IAM رول کے ساتھ منسلک EC2 انسٹینس پر چلایا جاتا ہے تو AWS SDK خودکار طور پر توثیق کے لیے instance metadata service (IMDS) استعمال کرتا ہے۔
تاہم، OpenClaw کی اسناد کی شناخت فی الحال صرف ماحولاتی متغیرات کو چیک کرتی ہے، IMDS اسناد کو نہیں۔

**حل:** AWS اسناد کی دستیابی کا اشارہ دینے کے لیے `AWS_PROFILE=default` سیٹ کریں۔ اصل توثیق پھر بھی IMDS کے ذریعے انسٹینس رول استعمال کرتی ہے۔

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 انسٹینس رول کے لیے **درکار IAM اجازتیں**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (خودکار دریافت کے لیے)

یا managed policy `AmazonBedrockFullAccess` منسلک کریں۔

**فوری سیٹ اپ:**

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

## نوٹس

- Bedrock کے لیے آپ کے AWS اکاؤنٹ/ریجن میں **model access** فعال ہونا ضروری ہے۔
- خودکار دریافت کے لیے `bedrock:ListFoundationModels` کی اجازت درکار ہے۔
- اگر آپ profiles استعمال کرتے ہیں تو گیٹ وے ہوسٹ پر `AWS_PROFILE` سیٹ کریں۔
- OpenClaw اس ترتیب میں اسناد کے ماخذ کو ظاہر کرتا ہے: `AWS_BEARER_TOKEN_BEDROCK`،
  پھر `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`، پھر `AWS_PROFILE`، اور آخر میں
  default AWS SDK chain۔
- reasoning کی سپورٹ ماڈل پر منحصر ہے؛ موجودہ صلاحیتوں کے لیے Bedrock ماڈل کارڈ چیک کریں۔
- اگر آپ managed key فلو کو ترجیح دیتے ہیں تو آپ Bedrock کے سامنے ایک OpenAI‑compatible
  پراکسی بھی رکھ سکتے ہیں اور اسے OpenAI فراہم کنندہ کے طور پر کنفیگر کر سکتے ہیں۔
