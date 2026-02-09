---
summary: "OpenClaw 와 함께 Amazon Bedrock (Converse API) 모델을 사용합니다"
read_when:
  - OpenClaw 와 함께 Amazon Bedrock 모델을 사용하려는 경우
  - 모델 호출을 위한 AWS 자격 증명/리전 설정이 필요한 경우
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw 는 pi‑ai 의 **Bedrock Converse** 스트리밍 프로바이더를 통해 **Amazon Bedrock** 모델을 사용할 수 있습니다. Bedrock 인증은 API 키가 아니라 **AWS SDK 기본 자격 증명 체인**을 사용합니다.

## pi‑ai 가 지원하는 항목

- 프로바이더: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 인증: AWS 자격 증명 (환경 변수, 공유 설정 또는 인스턴스 역할)
- 리전: `AWS_REGION` 또는 `AWS_DEFAULT_REGION` (기본값: `us-east-1`)

## 자동 모델 디스커버리

AWS 자격 증명이 감지되면, OpenClaw 는 **스트리밍**과 **텍스트 출력**을 지원하는 Bedrock 모델을 자동으로 검색할 수 있습니다. 디스커버리는 `bedrock:ListFoundationModels` 을 사용하며 캐시됩니다 (기본값: 1시간).

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

참고 사항:

- `enabled` 는 AWS 자격 증명이 있을 때 기본적으로 `true` 입니다.
- `region` 는 기본적으로 `AWS_REGION` 또는 `AWS_DEFAULT_REGION`, 이후 `us-east-1` 입니다.
- `providerFilter` 은 Bedrock 프로바이더 이름과 일치해야 합니다 (예: `anthropic`).
- `refreshInterval` 은 초 단위입니다; 캐싱을 비활성화하려면 `0` 로 설정하십시오.
- `defaultContextWindow` (기본값: `32000`) 및 `defaultMaxTokens` (기본값: `4096`)
  는 디스커버리된 모델에 사용됩니다 (모델 한계를 알고 있다면 재정의하십시오).

## 설정 (수동)

1. **Gateway(게이트웨이) 호스트**에서 AWS 자격 증명이 사용 가능해야 합니다:

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

2. 설정에 Bedrock 프로바이더와 모델을 추가합니다 (`apiKey` 필요 없음):

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

IAM 역할이 연결된 EC2 인스턴스에서 OpenClaw 를 실행하는 경우, AWS SDK 는 인증을 위해 인스턴스 메타데이터 서비스 (IMDS)를 자동으로 사용합니다.
그러나 OpenClaw 의 자격 증명 감지는 현재 환경 변수만 확인하며 IMDS 자격 증명은 확인하지 않습니다.

**해결 방법:** AWS 자격 증명이 사용 가능함을 알리기 위해 `AWS_PROFILE=default` 를 설정하십시오. 실제 인증은 여전히 IMDS 를 통한 인스턴스 역할을 사용합니다.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 인스턴스 역할에 필요한 **필수 IAM 권한**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (자동 디스커버리용)

또는 관리형 정책 `AmazonBedrockFullAccess` 를 연결하십시오.

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

## 참고 사항

- Bedrock 은 AWS 계정/리전에서 **모델 액세스**가 활성화되어 있어야 합니다.
- 자동 디스커버리는 `bedrock:ListFoundationModels` 권한이 필요합니다.
- 프로파일을 사용하는 경우, Gateway(게이트웨이) 호스트에서 `AWS_PROFILE` 를 설정하십시오.
- OpenClaw 는 다음 순서로 자격 증명 소스를 표시합니다: `AWS_BEARER_TOKEN_BEDROCK`,
  이후 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, 그 다음 `AWS_PROFILE`, 이후
  기본 AWS SDK 체인입니다.
- 추론(Reasoning) 지원 여부는 모델에 따라 다르므로, 최신 기능은 Bedrock 모델 카드를 확인하십시오.
- 관리형 키 흐름을 선호한다면, Bedrock 앞단에 OpenAI 호환 프록시를 두고 이를 OpenAI 프로바이더로 설정할 수도 있습니다.
