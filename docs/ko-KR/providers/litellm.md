---
summary: "OpenClaw를 LiteLLM 프록시를 통해 실행하여 통합 모델 접근 및 비용 추적"
read_when:
  - OpenClaw를 LiteLLM 프록시를 통해 라우팅하려는 경우
  - 비용 추적, 로깅 또는 모델 라우팅이 필요한 경우
---

# LiteLLM

[LiteLLM](https://litellm.ai)은 100개 이상의 모델 프로바이더에 대해 통합된 API를 제공하는 오픈 소스 LLM 게이트웨이입니다. LiteLLM을 통해 OpenClaw를 라우팅하여 중심화된 비용 추적, 로깅을 하고 OpenClaw 설정을 변경하지 않고 백엔드를 유연하게 변경할 수 있습니다.

## OpenClaw와 함께 LiteLLM을 사용하는 이유?

- **비용 추적** — OpenClaw가 모든 모델에 소비한 비용을 정확히 파악
- **모델 라우팅** — 설정 변경 없이 Claude, GPT-4, Gemini, Bedrock 간 전환
- **가상 키** — OpenClaw에 대한 지출 한도가 있는 키 생성
- **로깅** — 디버깅을 위한 전체 요청/응답 로그
- **페일오버** — 기본 프로바이더가 다운된 경우 자동으로 대체 제공

## 빠른 시작

### 온보딩 통해

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 수동 설정

1. LiteLLM 프록시 시작:

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. OpenClaw를 LiteLLM으로 지정:

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

이것으로 완료입니다. 이제 OpenClaw는 LiteLLM을 통해 라우팅됩니다.

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

OpenClaw에 대한 지출 한도가 있는 전용 키 생성:

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

생성된 키를 `LITELLM_API_KEY`로 사용합니다.

## 모델 라우팅

LiteLLM은 다른 백엔드로 모델 요청을 라우팅할 수 있습니다. LiteLLM `config.yaml`에서 설정하십시오:

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

OpenClaw는 계속해서 `claude-opus-4-6`을 요청하며, LiteLLM이 라우팅을 처리합니다.

## 사용량 보기

LiteLLM의 대시보드나 API를 확인하세요:

```bash
# 키 정보
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# 지출 로그
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 참고 사항

- LiteLLM은 기본적으로 `http://localhost:4000`에서 실행됩니다.
- OpenClaw는 OpenAI 호환 `/v1/chat/completions` 엔드포인트를 통해 연결됩니다.
- 모든 OpenClaw 기능은 LiteLLM을 통해 작동하며 제한이 없습니다.

## 참조

- [LiteLLM 문서](https://docs.litellm.ai)
- [모델 프로바이더](/ko-KR/concepts/model-providers)