---
summary: "OpenClaw के साथ Amazon Bedrock (Converse API) मॉडल का उपयोग करें"
read_when:
  - आप OpenClaw के साथ Amazon Bedrock मॉडल का उपयोग करना चाहते हैं
  - आपको मॉडल कॉल के लिए AWS क्रेडेंशियल/रीजन सेटअप की आवश्यकता है
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw can use **Amazon Bedrock** models via pi‑ai’s **Bedrock Converse**
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

## pi‑ai क्या समर्थन करता है

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS क्रेडेंशियल (env vars, साझा कॉन्फ़िग, या इंस्टेंस रोल)
- Region: `AWS_REGION` या `AWS_DEFAULT_REGION` (डिफ़ॉल्ट: `us-east-1`)

## स्वचालित मॉडल डिस्कवरी

If AWS credentials are detected, OpenClaw can automatically discover Bedrock
models that support **streaming** and **text output**. Discovery uses
`bedrock:ListFoundationModels` and is cached (default: 1 hour).

कॉन्फ़िग विकल्प `models.bedrockDiscovery` के अंतर्गत होते हैं:

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

नोट्स:

- `enabled` AWS क्रेडेंशियल उपलब्ध होने पर डिफ़ॉल्ट रूप से `true` होता है।
- `region` डिफ़ॉल्ट रूप से `AWS_REGION` या `AWS_DEFAULT_REGION`, फिर `us-east-1` होता है।
- `providerFilter` Bedrock प्रदाता नामों से मेल खाता है (उदाहरण के लिए `anthropic`)।
- `refreshInterval` सेकंड में है; कैशिंग अक्षम करने के लिए `0` पर सेट करें।
- `defaultContextWindow` (डिफ़ॉल्ट: `32000`) और `defaultMaxTokens` (डिफ़ॉल्ट: `4096`)
  खोजे गए मॉडलों के लिए उपयोग किए जाते हैं (यदि आपको अपने मॉडल की सीमाएँ पता हों तो ओवरराइड करें)।

## सेटअप (मैनुअल)

1. सुनिश्चित करें कि **Gateway होस्ट** पर AWS क्रेडेंशियल उपलब्ध हैं:

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

2. अपने कॉन्फ़िग में एक Bedrock प्रदाता और मॉडल जोड़ें ( `apiKey` आवश्यक नहीं):

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

## EC2 इंस्टेंस रोल्स

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

EC2 इंस्टेंस रोल के लिए **आवश्यक IAM अनुमतियाँ**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (स्वचालित डिस्कवरी के लिए)

या प्रबंधित पॉलिसी `AmazonBedrockFullAccess` संलग्न करें।

**त्वरित सेटअप:**

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

## नोट्स

- Bedrock के लिए आपके AWS अकाउंट/रीजन में **मॉडल एक्सेस** सक्षम होना आवश्यक है।
- स्वचालित डिस्कवरी के लिए `bedrock:ListFoundationModels` अनुमति की आवश्यकता होती है।
- यदि आप प्रोफाइल का उपयोग करते हैं, तो Gateway होस्ट पर `AWS_PROFILE` सेट करें।
- OpenClaw क्रेडेंशियल स्रोत को इस क्रम में दर्शाता है: `AWS_BEARER_TOKEN_BEDROCK`,
  फिर `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, फिर `AWS_PROFILE`, फिर
  डिफ़ॉल्ट AWS SDK चेन।
- रीज़निंग समर्थन मॉडल पर निर्भर करता है; वर्तमान क्षमताओं के लिए Bedrock मॉडल कार्ड देखें।
- यदि आप प्रबंधित कुंजी प्रवाह को प्राथमिकता देते हैं, तो आप Bedrock के सामने
  OpenAI‑संगत प्रॉक्सी भी रख सकते हैं और इसे OpenAI प्रदाता के रूप में कॉन्फ़िगर कर सकते हैं।
