---
summary: "OpenClaw 에서 Amazon Bedrock (Converse API) 모델 사용하기"
read_when:
  - OpenClaw 에서 Amazon Bedrock 모델을 사용하고 싶을 때
  - 모델 호출을 위한 AWS 자격 증명/리전 설정이 필요할 때
title: "Amazon Bedrock"
x-i18n:
  source_path: docs/providers/bedrock.md
---

# Amazon Bedrock

OpenClaw 는 pi-ai 의 **Bedrock Converse** 스트리밍 프로바이더를 통해 **Amazon Bedrock** 모델을 사용할 수 있습니다. Bedrock 인증은 API 키가 아닌 **AWS SDK 기본 자격 증명 체인** 을 사용합니다.

## pi-ai 지원 사항

- 프로바이더: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 인증: AWS 자격 증명 (환경 변수, 공유 설정 또는 인스턴스 역할)
- 리전: `AWS_REGION` 또는 `AWS_DEFAULT_REGION` (기본값: `us-east-1`)

## 자동 모델 검색

AWS 자격 증명이 감지되면, OpenClaw 는 **스트리밍** 과 **텍스트 출력** 을 지원하는 Bedrock 모델을 자동으로 검색할 수 있습니다. 검색은 `bedrock:ListFoundationModels` 를 사용하며 캐시됩니다 (기본값: 1 시간).

설정 옵션은 `models.bedrockDiscovery` 아래에 있습니다:

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

- `enabled` 는 AWS 자격 증명이 있을 때 기본적으로 `true` 입니다.
- `region` 은 `AWS_REGION` 또는 `AWS_DEFAULT_REGION` 을 기본값으로 사용하고, 그 다음 `us-east-1` 을 사용합니다.
- `providerFilter` 는 Bedrock 프로바이더 이름과 매칭됩니다 (예: `anthropic`).
- `refreshInterval` 은 초 단위입니다. `0` 으로 설정하면 캐싱이 비활성화됩니다.
- `defaultContextWindow` (기본값: `32000`) 및 `defaultMaxTokens` (기본값: `4096`) 는 검색된 모델에 사용됩니다 (모델 제한을 알고 있다면 재정의하세요).

## 온보딩

1. **Gateway 호스트** 에서 AWS 자격 증명이 사용 가능한지 확인하세요:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# 선택 사항:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# 선택 사항 (Bedrock API 키/베어러 토큰):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. 설정에 Bedrock 프로바이더와 모델을 추가합니다 (`apiKey` 불필요):

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

IAM 역할이 연결된 EC2 인스턴스에서 OpenClaw 를 실행할 때, AWS SDK 는 인증을 위해 인스턴스 메타데이터 서비스 (IMDS) 를 자동으로 사용합니다.
그러나 OpenClaw 의 자격 증명 감지는 현재 환경 변수만 확인하며 IMDS 자격 증명은 확인하지 않습니다.

**해결 방법:** AWS 자격 증명이 사용 가능하다는 것을 알리기 위해 `AWS_PROFILE=default` 를 설정하세요. 실제 인증은 여전히 IMDS 를 통한 인스턴스 역할을 사용합니다.

```bash
# ~/.bashrc 또는 셸 프로필에 추가
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 인스턴스 역할에 **필요한 IAM 권한**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (자동 검색용)

또는 관리형 정책 `AmazonBedrockFullAccess` 를 연결하세요.

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

# 3. EC2 인스턴스에서 검색 활성화
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 해결 방법 환경 변수 설정
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. 모델이 검색되었는지 확인
openclaw models list
```

## 참고 사항

- Bedrock 는 AWS 계정/리전에서 **모델 액세스** 가 활성화되어 있어야 합니다.
- 자동 검색에는 `bedrock:ListFoundationModels` 권한이 필요합니다.
- 프로필을 사용하는 경우 Gateway 호스트에서 `AWS_PROFILE` 을 설정하세요.
- OpenClaw 는 다음 순서로 자격 증명 소스를 표시합니다: `AWS_BEARER_TOKEN_BEDROCK`,
  그 다음 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, 그 다음 `AWS_PROFILE`, 그 다음
  기본 AWS SDK 체인.
- 추론 지원은 모델에 따라 다릅니다. 현재 기능은 Bedrock 모델 카드를 확인하세요.
- 관리형 키 플로우를 선호하는 경우, Bedrock 앞에 OpenAI 호환 프록시를 배치하고 대신 OpenAI 프로바이더로 설정할 수도 있습니다.
