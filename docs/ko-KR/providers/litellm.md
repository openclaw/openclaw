---
title: "LiteLLM"
summary: "통합 모델 액세스 및 비용 추적을 위해 LiteLLM Proxy 를 통해 OpenClaw 실행하기"
read_when:
  - OpenClaw 를 LiteLLM 프록시를 통해 라우팅하고 싶을 때
  - LiteLLM 을 통한 비용 추적, 로깅 또는 모델 라우팅이 필요할 때
x-i18n:
  source_path: docs/providers/litellm.md
---

# LiteLLM

[LiteLLM](https://litellm.ai) 은 100 개 이상의 모델 프로바이더에 대한 통합 API 를 제공하는 오픈소스 LLM 게이트웨이입니다. OpenClaw 를 LiteLLM 을 통해 라우팅하면 중앙 집중식 비용 추적, 로깅 및 OpenClaw 설정을 변경하지 않고 백엔드를 전환할 수 있는 유연성을 얻을 수 있습니다.

## LiteLLM 을 OpenClaw 와 함께 사용하는 이유

- **비용 추적** -- OpenClaw 가 모든 모델에서 소비하는 정확한 비용을 확인할 수 있습니다
- **모델 라우팅** -- 설정 변경 없이 Claude, GPT-4, Gemini, Bedrock 간 전환
- **가상 키** -- OpenClaw 에 대한 지출 한도가 있는 키 생성
- **로깅** -- 디버깅을 위한 전체 요청/응답 로그
- **폴백** -- 기본 프로바이더가 다운되면 자동 장애 조치

## 빠른 시작

### 온보딩을 통해

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 수동 설정

1. LiteLLM Proxy 를 시작합니다:

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. OpenClaw 를 LiteLLM 으로 연결합니다:

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

이것으로 완료입니다. OpenClaw 는 이제 LiteLLM 을 통해 라우팅됩니다.

## 설정

### 환경 변수

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 설정 파일

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

## 가상 키

OpenClaw 를 위한 지출 한도가 있는 전용 키를 생성합니다:

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

생성된 키를 `LITELLM_API_KEY` 로 사용하세요.

## 모델 라우팅

LiteLLM 은 모델 요청을 다른 백엔드로 라우팅할 수 있습니다. LiteLLM `config.yaml` 에서 설정하세요:

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

OpenClaw 는 계속 `claude-opus-4-6` 을 요청합니다 -- LiteLLM 이 라우팅을 처리합니다.

## 사용량 확인

LiteLLM 의 대시보드 또는 API 를 확인하세요:

```bash
# 키 정보
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# 지출 로그
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 참고 사항

- LiteLLM 은 기본적으로 `http://localhost:4000` 에서 실행됩니다
- OpenClaw 는 OpenAI 호환 `/v1/chat/completions` 엔드포인트를 통해 연결합니다
- 모든 OpenClaw 기능이 LiteLLM 을 통해 작동합니다 -- 제한 없음

## 참조

- [LiteLLM 문서](https://docs.litellm.ai)
- [Model Providers](/concepts/model-providers)
