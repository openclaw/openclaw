---
summary: "Use Amazon Bedrock (Converse API) models with OpenClaw"
read_when:
  - You want to use Amazon Bedrock models with OpenClaw
  - You need AWS credential/region setup for model calls
title: "Amazon Bedrock"
x-i18n:
  source_hash: d2e02a8c515862194cdcf968a3f97ad68eed2545b383f211e800b49e1faf21d1
---

# 아마존 베드락

OpenClaw는 pi‑ai의 **Bedrock Converse**를 통해 **Amazon Bedrock** 모델을 사용할 수 있습니다.
스트리밍 제공업체. Bedrock 인증은 **AWS SDK 기본 자격 증명 체인**을 사용합니다.
API 키가 아닙니다.

## pi‑ai가 지원하는 것

- 제공자 : `amazon-bedrock`
- API: `bedrock-converse-stream`
- 인증: AWS 자격 증명(환경 변수, 공유 구성 또는 인스턴스 역할)
- 지역: `AWS_REGION` 또는 `AWS_DEFAULT_REGION` (기본값: `us-east-1`)

## 자동 모델 검색

AWS 자격 증명이 감지되면 OpenClaw는 자동으로 Bedrock을 검색할 수 있습니다.
**스트리밍** 및 **텍스트 출력**을 지원하는 모델입니다. 발견 용도
`bedrock:ListFoundationModels` 캐시되며(기본값: 1시간)

구성 옵션은 `models.bedrockDiscovery` 아래에 있습니다.

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

참고:

- AWS 자격 증명이 있는 경우 `enabled`의 기본값은 `true`입니다.
- `region`의 기본값은 `AWS_REGION` 또는 `AWS_DEFAULT_REGION`이고 그 다음은 `us-east-1`입니다.
- `providerFilter`는 Bedrock 공급자 이름과 일치합니다(예: `anthropic`).
- `refreshInterval`는 초입니다. 캐싱을 비활성화하려면 `0`로 설정하세요.
- `defaultContextWindow` (기본값: `32000`) 및 `defaultMaxTokens` (기본값: `4096`)
  검색된 모델에 사용됩니다(모델 제한을 알고 있는 경우 재정의).

## 설정(수동)

1. **게이트웨이 호스트**에서 AWS 자격 증명을 사용할 수 있는지 확인합니다.

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

2. 구성에 Bedrock 공급자 및 모델을 추가합니다(`apiKey` 필요 없음).

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

## EC2 인스턴스 역할

IAM 역할이 연결된 EC2 인스턴스에서 OpenClaw를 실행하면 AWS SDK
인증을 위해 인스턴스 메타데이터 서비스(IMDS)를 자동으로 사용합니다.
그러나 OpenClaw의 자격 증명 탐지는 현재 환경만 확인합니다.
IMDS 자격 증명이 아닌 변수입니다.

**해결 방법:** `AWS_PROFILE=default`를 설정하여 AWS 자격 증명이
가능합니다. 실제 인증에서는 여전히 IMDS를 통한 인스턴스 역할을 사용합니다.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 인스턴스 역할에 필요한 **IAM 권한**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (자동 검색용)

또는 관리형 정책 `AmazonBedrockFullAccess`을 연결하세요.

**빠른 설정:**

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

## 메모

- Bedrock에는 AWS 계정/지역에서 활성화된 **모델 액세스**가 필요합니다.
- 자동 검색에는 `bedrock:ListFoundationModels` 권한이 필요합니다.
- 프로파일을 사용하는 경우 게이트웨이 호스트에 `AWS_PROFILE`를 설정합니다.
- OpenClaw는 `AWS_BEARER_TOKEN_BEDROCK` 순서로 자격 증명 소스를 표시합니다.
  그 다음 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, 그 다음 `AWS_PROFILE`, 그 다음
  기본 AWS SDK 체인.
- 추론 지원은 모델에 따라 다릅니다. Bedrock 모델 카드를 확인하세요.
  현재 능력.
- 관리형 키 흐름을 선호하는 경우 OpenAI 호환 키 흐름을 배치할 수도 있습니다.
  Bedrock 앞에서 프록시를 사용하고 대신 OpenAI 공급자로 구성합니다.
