---
summary: "SGLang (OpenAI 호환 자체 호스팅 서버) 에서 OpenClaw 실행하기"
read_when:
  - 로컬 SGLang 서버에서 OpenClaw 를 실행하고 싶을 때
  - 자체 모델로 OpenAI 호환 /v1 엔드포인트를 원할 때
title: "SGLang"
x-i18n:
  source_path: docs/providers/sglang.md
---

# SGLang

SGLang 은 **OpenAI 호환** HTTP API 를 통해 오픈소스 모델을 서빙할 수 있습니다.
OpenClaw 는 `openai-completions` API 를 사용하여 SGLang 에 연결할 수 있습니다.

OpenClaw 는 `SGLANG_API_KEY` (서버가 인증을 강제하지 않으면 어떤 값이든 작동) 로 옵트인하고 명시적 `models.providers.sglang` 항목을 정의하지 않으면 SGLang 에서 사용 가능한 모델을 **자동 검색** 할 수도 있습니다.

## 빠른 시작

1. OpenAI 호환 서버로 SGLang 을 시작합니다.

기본 URL 은 `/v1` 엔드포인트 (예: `/v1/models`, `/v1/chat/completions`) 를 노출해야 합니다. SGLang 은 일반적으로 다음에서 실행됩니다:

- `http://127.0.0.1:30000/v1`

2. 옵트인합니다 (인증이 설정되지 않은 경우 어떤 값이든 작동):

```bash
export SGLANG_API_KEY="sglang-local"
```

3. 온보딩을 실행하고 `SGLang` 을 선택하거나, 모델을 직접 설정합니다:

```bash
openclaw onboard
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## 모델 검색 (암시적 프로바이더)

`SGLANG_API_KEY` 가 설정되어 있고 (또는 인증 프로필이 존재하고) `models.providers.sglang` 을 **정의하지 않으면**, OpenClaw 는 다음을 조회합니다:

- `GET http://127.0.0.1:30000/v1/models`

반환된 ID 를 모델 항목으로 변환합니다.

`models.providers.sglang` 을 명시적으로 설정하면 자동 검색이 건너뛰어지며 모델을 수동으로 정의해야 합니다.

## 명시적 설정 (수동 모델)

다음과 같은 경우 명시적 설정을 사용합니다:

- SGLang 이 다른 호스트/포트에서 실행 중인 경우.
- `contextWindow`/`maxTokens` 값을 고정하고 싶은 경우.
- 서버에 실제 API 키가 필요한 경우 (또는 헤더를 제어하고 싶은 경우).

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
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
curl http://127.0.0.1:30000/v1/models
```

- 인증 오류로 요청이 실패하면, 서버 설정과 일치하는 실제 `SGLANG_API_KEY` 를 설정하거나,
  `models.providers.sglang` 에서 프로바이더를 명시적으로 설정하세요.
