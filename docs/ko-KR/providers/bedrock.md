---
summary: "OpenClaw에서 Amazon Bedrock (Converse API) 모델을 사용합니다"
read_when:
  - OpenClaw에서 Amazon Bedrock 모델을 사용하고 싶을 때
  - 모델 호출을 위해 AWS 자격증명/영역 설정이 필요할 때
title: "Amazon Bedrock"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/bedrock.md"
  workflow: 15
---

# Amazon Bedrock

OpenClaw는 pi‑ai의 **Bedrock Converse** 스트리밍 제공자를 통해 **Amazon Bedrock** 모델을 사용할 수 있습니다. Bedrock 인증은 API 키가 아닌 **AWS SDK 기본 자격증명 체인**을 사용합니다.

## pi‑ai가 지원하는 것

- 제공자: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 인증: AWS 자격증명 (환경 변수, 공유 구성, 또는 인스턴스 역할)
- 영역: `AWS_REGION` 또는 `AWS_DEFAULT_REGION` (기본값: `us-east-1`)

## 자동 모델 발견

AWS 자격증명이 감지되면 OpenClaw는 **스트리밍** 및 **텍스트 출력**을 지원하는 Bedrock 모델을 자동으로 발견할 수 있습니다. 발견은 `bedrock:ListFoundationModels`를 사용하며 캐시됩니다 (기본값: 1시간).

구성 옵션은 `models.bedrockDiscovery` 아래에 있습니다:

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

- `enabled`는 AWS 자격증명이 있을 때 `true`로 기본값입니다.
- `region`은 `AWS_REGION` 또는 `AWS_DEFAULT_REGION`으로 기본값, 그 다음 `us-east-1`.
- `providerFilter`는 Bedrock 제공자 이름과 일치합니다 (예: `anthropic`).
- `refreshInterval`은 초; 캐싱을 비활성화하려면 `0`으로 설정합니다.
- `defaultContextWindow` (기본값: `32000`) 및 `defaultMaxTokens` (기본값: `4096`)는 발견된 모델에 사용되며, 모델 제한을 아는 경우 재정의합니다.

## 온보딩

1. **게이트웨이 호스트**에서 AWS 자격증명을 사용 가능하도록 합니다:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# 선택사항:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# 선택사항 (Bedrock API 키/bearer 토큰):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. Bedrock 제공자 및 모델을 구성에 추가합니다 (`apiKey`는 필요하지 않음):

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

EC2 인스턴스에 IAM 역할이 연결되어 OpenClaw를 실행할 때 AWS SDK는 인스턴스 메타데이터 서비스 (IMDS)를 자동으로 인증에 사용합니다.
하지만 OpenClaw의 자격증명 감지는 현재 IMDS 자격증명이 아닌 환경 변수만 확인합니다.

**해결 방법:** AWS 자격증명을 사용 가능함을 나타내려면 `AWS_PROFILE=default`를 설정합니다. 실제 인증은 IMDS를 통해 인스턴스 역할을 사용합니다.

```bash
# ~/.bashrc 또는 셸 프로필에 추가
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**EC2 인스턴스 역할에 필요한 IAM 권한**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (자동 발견용)

또는 관리 정책 `AmazonBedrockFullAccess`를 연결합니다.

## 빠른 설정 (AWS 경로)

```bash
# 1. IAM 역할 및 인스턴스 프로필 생성
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

# 2. EC2 인스턴스에 연결
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. EC2 인스턴스에서 발견 활성화
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 해결 방법 환경 변수 설정
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. 모델이 발견되는지 확인
openclaw models list
```

## 참고

- Bedrock을 사용하려면 AWS 계정/영역에서 **모델 액세스**를 활성화해야 합니다.
- 자동 발견에는 `bedrock:ListFoundationModels` 권한이 필요합니다.
- 프로필을 사용하면 게이트웨이 호스트에서 `AWS_PROFILE`을 설정합니다.
- OpenClaw는 자격증명 소스를 이 순서로 표시합니다: `AWS_BEARER_TOKEN_BEDROCK`, 그 다음 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, 그 다음 `AWS_PROFILE`, 그 다음 기본 AWS SDK 체인.
- 추론 지원은 모델에 따라 다릅니다. 현재 기능은 Bedrock 모델 카드를 확인합니다.
- 관리 키 흐름을 선호하는 경우 Bedrock 앞에 OpenAI‑호환 프록시를 배치하고 대신 OpenAI 제공자로 구성할 수도 있습니다.
