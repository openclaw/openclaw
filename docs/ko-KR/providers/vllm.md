---
summary: "vLLM (OpenAI 호환 로컬 서버) 에서 OpenClaw 실행하기"
read_when:
  - 로컬 vLLM 서버에서 OpenClaw 를 실행하고 싶을 때
  - 자체 모델로 OpenAI 호환 /v1 엔드포인트를 원할 때
title: "vLLM"
x-i18n:
  source_path: docs/providers/vllm.md
---

# vLLM

vLLM 은 **OpenAI 호환** HTTP API 를 통해 오픈소스 (및 일부 사용자 정의) 모델을 서빙할 수 있습니다. OpenClaw 는 `openai-completions` API 를 사용하여 vLLM 에 연결할 수 있습니다.

OpenClaw 는 `VLLM_API_KEY` (서버가 인증을 강제하지 않으면 어떤 값이든 작동) 로 옵트인하고 명시적 `models.providers.vllm` 항목을 정의하지 않으면 vLLM 에서 사용 가능한 모델을 **자동 검색** 할 수도 있습니다.

## 빠른 시작

1. OpenAI 호환 서버로 vLLM 을 시작합니다.

기본 URL 은 `/v1` 엔드포인트 (예: `/v1/models`, `/v1/chat/completions`) 를 노출해야 합니다. vLLM 은 일반적으로 다음에서 실행됩니다:

- `http://127.0.0.1:8000/v1`

2. 옵트인합니다 (인증이 설정되지 않은 경우 어떤 값이든 작동):

```bash
export VLLM_API_KEY="vllm-local"
```

3. 모델을 선택합니다 (vLLM 모델 ID 중 하나로 교체하세요):

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## 모델 검색 (암시적 프로바이더)

`VLLM_API_KEY` 가 설정되어 있고 (또는 인증 프로필이 존재하고) `models.providers.vllm` 을 **정의하지 않으면**, OpenClaw 는 다음을 조회합니다:

- `GET http://127.0.0.1:8000/v1/models`

반환된 ID 를 모델 항목으로 변환합니다.

`models.providers.vllm` 을 명시적으로 설정하면 자동 검색이 건너뛰어지며 모델을 수동으로 정의해야 합니다.

## 명시적 설정 (수동 모델)

다음과 같은 경우 명시적 설정을 사용합니다:

- vLLM 이 다른 호스트/포트에서 실행 중인 경우.
- `contextWindow`/`maxTokens` 값을 고정하고 싶은 경우.
- 서버에 실제 API 키가 필요한 경우 (또는 헤더를 제어하고 싶은 경우).

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 문제 해결

- 서버에 접근 가능한지 확인합니다:

```bash
curl http://127.0.0.1:8000/v1/models
```

- 인증 오류로 요청이 실패하면, 서버 설정과 일치하는 실제 `VLLM_API_KEY` 를 설정하거나, `models.providers.vllm` 에서 프로바이더를 명시적으로 설정하세요.
