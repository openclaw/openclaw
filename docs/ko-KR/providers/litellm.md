---
summary: "Run OpenClaw through LiteLLM Proxy for unified model access and cost tracking"
read_when:
  - You want to route OpenClaw through a LiteLLM proxy
  - You need cost tracking, logging, or model routing through LiteLLM
x-i18n:
  source_hash: 269529671c60864972441606c730b5ca327546a45d3b264dbd03204c4401936f
---

# LiteLLM

[LiteLLM](https://litellm.ai)은 100개 이상의 모델 제공자에게 통합 API를 제공하는 오픈 소스 LLM 게이트웨이입니다. LiteLLM을 통해 OpenClaw를 라우팅하여 중앙 집중식 비용 추적, 로깅 및 OpenClaw 구성을 변경하지 않고도 백엔드를 전환할 수 있는 유연성을 확보하세요.

## OpenClaw와 함께 LiteLLM을 사용하는 이유는 무엇입니까?

- **비용 추적** — OpenClaw가 모든 모델에 걸쳐 지출하는 금액을 정확히 확인하세요.
- **모델 라우팅** — 구성 변경 없이 Claude, GPT-4, Gemini, Bedrock 간 전환
- **가상 키** — OpenClaw에 대한 지출 한도가 있는 키 생성
- **로깅** — 디버깅을 위한 전체 요청/응답 로그
- **대체** — 기본 공급자가 다운된 경우 자동 장애 조치

## 빠른 시작

### 온보딩을 통해

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 수동 설정

1. LiteLLM 프록시를 시작합니다:

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. OpenClaw를 LiteLLM으로 지정:

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

그게 다야. OpenClaw는 이제 LiteLLM을 통해 라우팅됩니다.

## 구성

### 환경 변수

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 구성 파일

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

지출 한도가 있는 OpenClaw 전용 키를 생성하세요.

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

생성된 키를 `LITELLM_API_KEY`로 사용하세요.

## 모델 라우팅

LiteLLM은 모델 요청을 다른 백엔드로 라우팅할 수 있습니다. LiteLLM `config.yaml`에서 구성합니다.

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

OpenClaw가 계속 `claude-opus-4-6`를 요청합니다. LiteLLM이 라우팅을 처리합니다.

## 사용량 보기

LiteLLM의 대시보드 또는 API를 확인하세요.

```bash
# Key info
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# Spend logs
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 메모

- LiteLLM은 기본적으로 `http://localhost:4000`에서 실행됩니다.
- OpenClaw는 OpenAI 호환 `/v1/chat/completions` 엔드포인트를 통해 연결됩니다.
- 모든 OpenClaw 기능은 LiteLLM을 통해 작동 — 제한 없음

## 참고하세요

- [LiteLLM 문서](https://docs.litellm.ai)
- [모델 제공자](/concepts/model-providers)
