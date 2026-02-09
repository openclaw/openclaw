---
summary: "ใช้โมเดล Amazon Bedrock (Converse API) กับ OpenClaw"
read_when:
  - คุณต้องการใช้โมเดล Amazon Bedrock กับ OpenClaw
  - คุณต้องการตั้งค่าข้อมูลประจำตัว/ภูมิภาคของ AWS สำหรับการเรียกโมเดล
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw สามารถใช้โมเดล **Amazon Bedrock** ผ่านผู้ให้บริการสตรีมมิง **Bedrock Converse** ของ pi‑ai ได้ การยืนยันตัวตนของ Bedrock ใช้ **AWS SDK default credential chain** ไม่ใช่คีย์API 39. การยืนยันตัวตนของ Bedrock ใช้ **AWS SDK default credential chain**
ไม่ใช่ API key

## สิ่งที่ pi‑ai รองรับ

- ผู้ให้บริการ: `amazon-bedrock`
- API: `bedrock-converse-stream`
- การยืนยันตัวตน: ข้อมูลประจำตัว AWS (ตัวแปรสภาพแวดล้อม, คอนฟิกที่แชร์, หรือบทบาทอินสแตนซ์)
- ภูมิภาค: `AWS_REGION` หรือ `AWS_DEFAULT_REGION` (ค่าเริ่มต้น: `us-east-1`)

## การค้นหาโมเดลอัตโนมัติ

หากตรวจพบข้อมูลประจำตัว AWS, OpenClaw สามารถค้นหาโมเดล Bedrock ที่รองรับ **การสตรีม** และ **เอาต์พุตข้อความ** ได้โดยอัตโนมัติ การค้นหาใช้ `bedrock:ListFoundationModels` และมีการแคช (ค่าเริ่มต้น: 1 ชั่วโมง) 40. การค้นหาใช้
`bedrock:ListFoundationModels` และมีการแคชไว้ (ค่าเริ่มต้น: 1 ชั่วโมง)

ตัวเลือกคอนฟิกอยู่ภายใต้ `models.bedrockDiscovery`:

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

หมายเหตุ:

- `enabled` จะเป็นค่าเริ่มต้น `true` เมื่อมีข้อมูลประจำตัว AWS
- `region` จะเป็นค่าเริ่มต้น `AWS_REGION` หรือ `AWS_DEFAULT_REGION` จากนั้นเป็น `us-east-1`
- `providerFilter` ตรงกับชื่อผู้ให้บริการของ Bedrock (เช่น `anthropic`)
- `refreshInterval` เป็นวินาที; ตั้งค่าเป็น `0` เพื่อปิดการแคช
- `defaultContextWindow` (ค่าเริ่มต้น: `32000`) และ `defaultMaxTokens` (ค่าเริ่มต้น: `4096`)
  ใช้สำหรับโมเดลที่ค้นพบ (แทนที่ได้หากคุณทราบขีดจำกัดของโมเดล)

## การตั้งค่า (ด้วยตนเอง)

1. ตรวจสอบให้แน่ใจว่ามีข้อมูลประจำตัว AWS บน **โฮสต์Gateway**:

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

2. เพิ่มผู้ให้บริการ Bedrock และโมเดลลงในคอนฟิกของคุณ (ไม่ต้องใช้ `apiKey`):

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

## บทบาทอินสแตนซ์ EC2

เมื่อรัน OpenClaw บนอินสแตนซ์ EC2 ที่มีการแนบบทบาท IAM, AWS SDK จะใช้บริการเมทาดาทาของอินสแตนซ์ (IMDS) เพื่อยืนยันตัวตนโดยอัตโนมัติ อย่างไรก็ตาม การตรวจจับข้อมูลประจำตัวของ OpenClaw ในปัจจุบันตรวจสอบเฉพาะตัวแปรสภาพแวดล้อม ไม่ได้ตรวจสอบข้อมูลประจำตัวจาก IMDS
41. อย่างไรก็ตาม การตรวจจับข้อมูลรับรองของ OpenClaw ในปัจจุบันตรวจสอบเฉพาะตัวแปรสภาพแวดล้อม
ไม่ใช่ข้อมูลรับรองจาก IMDS

**วิธีแก้ไขชั่วคราว:** ตั้งค่า `AWS_PROFILE=default` เพื่อส่งสัญญาณว่ามีข้อมูลประจำตัว AWS พร้อมใช้งาน การยืนยันตัวตนจริงยังคงใช้บทบาทอินสแตนซ์ผ่าน IMDS 42. การยืนยันตัวตนจริงยังคงใช้ role ของอินสแตนซ์ผ่าน IMDS

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**สิทธิ์ IAM ที่จำเป็น** สำหรับบทบาทอินสแตนซ์ EC2:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (สำหรับการค้นหาอัตโนมัติ)

หรือแนบนโยบายที่จัดการแล้ว `AmazonBedrockFullAccess`

**การตั้งค่าอย่างรวดเร็ว:**

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

## หมายเหตุ

- Bedrock ต้องเปิดใช้งาน **การเข้าถึงโมเดล** ในบัญชี/ภูมิภาค AWS ของคุณ
- การค้นหาอัตโนมัติต้องใช้สิทธิ์ `bedrock:ListFoundationModels`
- หากใช้โปรไฟล์ ให้ตั้งค่า `AWS_PROFILE` บนโฮสต์Gateway
- OpenClaw แสดงแหล่งที่มาของข้อมูลประจำตัวตามลำดับนี้: `AWS_BEARER_TOKEN_BEDROCK`,
  จากนั้น `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, จากนั้น `AWS_PROFILE`, แล้วจึงเป็น
  default AWS SDK chain
- การรองรับการให้เหตุผลขึ้นอยู่กับโมเดล; โปรดตรวจสอบการ์ดโมเดลของ Bedrock สำหรับความสามารถล่าสุด
- หากคุณต้องการโฟลว์คีย์แบบจัดการ คุณสามารถวางพร็อกซีที่เข้ากันได้กับ OpenAI ไว้หน้าบริการ Bedrock และกำหนดค่าเป็นผู้ให้บริการ OpenAI แทน
