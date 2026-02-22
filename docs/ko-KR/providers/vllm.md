---
summary: "vLLM (OpenAI 호환 로컬 서버)로 OpenClaw 실행"
read_when:
  - 로컬 vLLM 서버에 대해 OpenClaw를 실행하려는 경우
  - 자체 모델로 OpenAI 호환 /v1 엔드포인트를 사용하려는 경우
title: "vLLM"
---

# vLLM

vLLM은 **OpenAI 호환** HTTP API를 통해 오픈 소스(및 일부 커스텀) 모델을 제공할 수 있습니다. OpenClaw는 `openai-completions` API를 사용하여 vLLM에 연결할 수 있습니다.

OpenClaw는 `VLLM_API_KEY`를 사용하여 선택했을 때(vLLM 서버가 인증을 요구하지 않는다면 아무 값이나 사용 가능) 명시적으로 `models.providers.vllm` 항목을 정의하지 않은 경우 vLLM에서 사용 가능한 모델을 **자동 검색**할 수도 있습니다.

## 빠른 시작

1. OpenAI 호환 서버로 vLLM을 시작합니다.

기본 URL은 `/v1` 엔드포인트를 노출해야 합니다 (예: `/v1/models`, `/v1/chat/completions`). vLLM은 일반적으로 다음에서 실행됩니다:

- `http://127.0.0.1:8000/v1`

2. 선택합니다 (인증이 구성되지 않은 경우 아무 값이나 작동합니다):

```bash
export VLLM_API_KEY="vllm-local"
```

3. 모델을 선택합니다 (vLLM 모델 ID 중 하나로 교체):

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

`VLLM_API_KEY`가 설정되고 (또는 인증 프로파일이 존재) `models.providers.vllm`을 정의하지 않은 경우, OpenClaw는 다음을 쿼리합니다:

- `GET http://127.0.0.1:8000/v1/models`

…그리고 반환된 ID를 모델 항목으로 변환합니다.

`models.providers.vllm`을 명시적으로 설정한 경우, 자동 검색은 건너뛰어지고 모델은 수동으로 정의해야 합니다.

## 명시적 구성 (수동 모델)

다음 경우 명시적 구성을 사용합니다:

- vLLM이 다른 호스트/포트에서 실행됩니다.
- `contextWindow`/`maxTokens` 값을 고정하려는 경우.
- 서버에서 실제 API 키가 필요하거나 헤더를 제어하려는 경우.

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

- 서버에 접근할 수 있는지 확인합니다:

```bash
curl http://127.0.0.1:8000/v1/models
```

- 요청이 인증 오류로 실패하는 경우, 서버 구성과 일치하는 실제 `VLLM_API_KEY`를 설정하거나 `models.providers.vllm` 하에 프로바이더를 명시적으로 구성합니다.