---
summary: "OpenClaw နှင့်အတူ Amazon Bedrock (Converse API) မော်ဒယ်များကို အသုံးပြုပါ"
read_when:
  - OpenClaw နှင့်အတူ Amazon Bedrock မော်ဒယ်များကို အသုံးပြုလိုသောအခါ
  - မော်ဒယ်ခေါ်ယူမှုများအတွက် AWS အထောက်အထား/ဒေသ သတ်မှတ်မှု လိုအပ်သောအခါ
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw သည် pi‑ai ၏ **Bedrock Converse** streaming provider မှတဆင့် **Amazon Bedrock** models များကို အသုံးပြုနိုင်ပါသည်။ Bedrock auth သည် API key မဟုတ်ဘဲ **AWS SDK default credential chain** ကို အသုံးပြုပါသည်။

## pi‑ai မှ ပံ့ပိုးထားသည်များ

- Provider: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Auth: AWS အထောက်အထားများ (env vars, shared config, သို့မဟုတ် instance role)
- Region: `AWS_REGION` သို့မဟုတ် `AWS_DEFAULT_REGION` (မူလတန်ဖိုး: `us-east-1`)

## မော်ဒယ် အလိုအလျောက် ရှာဖွေတွေ့ရှိမှု

AWS credentials များကို တွေ့ရှိပါက OpenClaw သည် **streaming** နှင့် **text output** ကို support လုပ်သော Bedrock models များကို အလိုအလျောက် discover လုပ်နိုင်ပါသည်။ Discovery သည် `bedrock:ListFoundationModels` ကို အသုံးပြုပြီး cache လုပ်ထားသည် (မူလသတ်မှတ်ချက်: ၁ နာရီ)။

Config ရွေးချယ်မှုများသည် `models.bedrockDiscovery` အောက်တွင် ရှိပါသည်—

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

မှတ်ချက်များ:

- `enabled` သည် AWS အထောက်အထားများ ရှိပါက မူလတန်ဖိုးအားဖြင့် `true` ဖြစ်သည်။
- `region` သည် မူလတန်ဖိုးအားဖြင့် `AWS_REGION` သို့မဟုတ် `AWS_DEFAULT_REGION` ဖြစ်ပြီး ထို့နောက် `us-east-1` ဖြစ်သည်။
- `providerFilter` သည် Bedrock provider အမည်များနှင့် ကိုက်ညီသည် (ဥပမာ `anthropic`)။
- `refreshInterval` သည် စက္ကန့်ဖြစ်ပြီး cache ကို ပိတ်ရန် `0` သတ်မှတ်ပါ။
- `defaultContextWindow` (မူလတန်ဖိုး: `32000`) နှင့် `defaultMaxTokens` (မူလတန်ဖိုး: `4096`)
  ကို ရှာဖွေတွေ့ရှိထားသော မော်ဒယ်များအတွက် အသုံးပြုသည် (သင့်မော်ဒယ် အကန့်အသတ်များကို သိပါက override ပြုလုပ်နိုင်သည်)။

## တပ်ဆင်ခြင်း (လက်ဖြင့်)

1. **Gateway ဟို့စ်** ပေါ်တွင် AWS အထောက်အထားများ ရရှိနိုင်ကြောင်း သေချာပါစေ—

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

2. သင့် config ထဲသို့ Bedrock provider နှင့် မော်ဒယ်ကို ထည့်ပါ (`apiKey` မလိုအပ်ပါ)—

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

IAM role ကို ချိတ်ဆက်ထားသော EC2 instance ပေါ်တွင် OpenClaw ကို chạy လုပ်သောအခါ AWS SDK သည် authentication အတွက် instance metadata service (IMDS) ကို အလိုအလျောက် အသုံးပြုမည်ဖြစ်သည်။
သို့သော် OpenClaw ၏ credential detection သည် လက်ရှိတွင် environment variables များကိုသာ စစ်ဆေးပြီး IMDS credentials များကို မစစ်ဆေးပါ။

**Workaround:** AWS credentials ရရှိနိုင်ကြောင်း ပြသရန် `AWS_PROFILE=default` ကို သတ်မှတ်ပါ။ အမှန်တကယ် authentication သည် IMDS မှတဆင့် instance role ကို အသုံးပြုနေဆဲဖြစ်သည်။

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**EC2 instance role အတွက် လိုအပ်သော IAM ခွင့်ပြုချက်များ**—

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (အလိုအလျောက် ရှာဖွေတွေ့ရှိမှုအတွက်)

သို့မဟုတ် managed policy `AmazonBedrockFullAccess` ကို ချိတ်ဆက်နိုင်သည်။

**အမြန်တပ်ဆင်ရန်:**

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

## မှတ်ချက်များ

- Bedrock ကို အသုံးပြုရန် သင့် AWS အကောင့်/ဒေသတွင် **model access** ကို ဖွင့်ထားရန် လိုအပ်သည်။
- အလိုအလျောက် ရှာဖွေတွေ့ရှိမှုအတွက် `bedrock:ListFoundationModels` ခွင့်ပြုချက် လိုအပ်သည်။
- profiles ကို အသုံးပြုပါက Gateway ဟို့စ် ပေါ်တွင် `AWS_PROFILE` ကို သတ်မှတ်ပါ။
- OpenClaw သည် အထောက်အထား ရင်းမြစ်ကို အောက်ပါ အစီအစဉ်အတိုင်း ပြသသည်—`AWS_BEARER_TOKEN_BEDROCK`,
  ထို့နောက် `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, ထို့နောက် `AWS_PROFILE`, ထို့နောက်
  default AWS SDK chain ဖြစ်သည်။
- Reasoning ပံ့ပိုးမှုသည် မော်ဒယ်ပေါ်မူတည်ပါသည်; လက်ရှိ စွမ်းဆောင်ရည်များအတွက် Bedrock မော်ဒယ်ကတ်ကို စစ်ဆေးပါ။
- Managed key flow ကို နှစ်သက်ပါက Bedrock ရှေ့တွင် OpenAI‑compatible proxy တစ်ခုကို ထားရှိပြီး OpenAI provider အဖြစ် configure လုပ်၍လည်း အသုံးပြုနိုင်ပါသည်။
