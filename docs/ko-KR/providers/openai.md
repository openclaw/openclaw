---
summary: "OpenClaw 에서 API 키 또는 Codex 구독을 사용하여 OpenAI 를 이용하는 방법"
read_when:
  - OpenClaw 에서 OpenAI 모델을 사용하고 싶을 때
  - API 키 대신 Codex 구독 인증을 사용하고 싶을 때
title: "OpenAI"
x-i18n:
  source_path: docs/providers/openai.md
---

# OpenAI

OpenAI 는 GPT 모델에 대한 개발자 API 를 제공합니다. Codex 는 구독 액세스를 위한 **ChatGPT 로그인** 또는 사용량 기반 액세스를 위한 **API 키** 로그인을 지원합니다. Codex 클라우드는 ChatGPT 로그인이 필요합니다.
OpenAI 는 OpenClaw 와 같은 외부 도구/워크플로우에서 구독 OAuth 사용을 명시적으로 지원합니다.

## 옵션 A: OpenAI API 키 (OpenAI Platform)

**적합한 경우:** 직접 API 액세스 및 사용량 기반 과금.
OpenAI 대시보드에서 API 키를 받으세요.

### CLI 설정

```bash
openclaw onboard --auth-choice openai-api-key
# 또는 비대화형으로
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 설정 스니펫

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAI 의 현재 API 모델 문서에는 직접 OpenAI API 사용을 위한 `gpt-5.4` 와 `gpt-5.4-pro` 가 나열되어 있습니다. OpenClaw 는 둘 다 `openai/*` Responses 경로를 통해 전달합니다.
OpenClaw 는 의도적으로 오래된 `openai/gpt-5.3-codex-spark` 행을 억제합니다. 이는 직접 OpenAI API 호출이 라이브 트래픽에서 이를 거부하기 때문입니다.

OpenClaw 는 직접 OpenAI API 경로에서 `openai/gpt-5.3-codex-spark` 를 노출하지 **않습니다**. `pi-ai` 는 여전히 해당 모델에 대한 내장 행을 제공하지만, 라이브 OpenAI API 요청은 현재 이를 거부합니다. Spark 는 OpenClaw 에서 Codex 전용으로 취급됩니다.

## 옵션 B: OpenAI Code (Codex) 구독

**적합한 경우:** API 키 대신 ChatGPT/Codex 구독 액세스 사용.
Codex 클라우드는 ChatGPT 로그인이 필요하며, Codex CLI 는 ChatGPT 또는 API 키 로그인을 지원합니다.

### CLI 설정 (Codex OAuth)

```bash
# 마법사에서 Codex OAuth 실행
openclaw onboard --auth-choice openai-codex

# 또는 OAuth 직접 실행
openclaw models auth login --provider openai-codex
```

### 설정 스니펫 (Codex 구독)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

OpenAI 의 현재 Codex 문서에는 `gpt-5.4` 가 현재 Codex 모델로 나열되어 있습니다. OpenClaw 는 이를 ChatGPT/Codex OAuth 사용을 위한 `openai-codex/gpt-5.4` 로 매핑합니다.

Codex 계정이 Codex Spark 에 대한 권한이 있는 경우, OpenClaw 는 다음도 지원합니다:

- `openai-codex/gpt-5.3-codex-spark`

OpenClaw 는 Codex Spark 를 Codex 전용으로 취급합니다. 직접 `openai/gpt-5.3-codex-spark` API 키 경로를 노출하지 않습니다.

OpenClaw 는 `pi-ai` 가 검색하면 `openai-codex/gpt-5.3-codex-spark` 도 유지합니다. 이를 권한 의존적이고 실험적인 것으로 취급하세요: Codex Spark 는 GPT-5.4 `/fast` 와 별개이며, 가용성은 로그인한 Codex / ChatGPT 계정에 따라 다릅니다.

### 전송 기본값

OpenClaw 는 모델 스트리밍에 `pi-ai` 를 사용합니다. `openai/*` 와 `openai-codex/*` 모두 기본 전송은 `"auto"` (WebSocket 우선, SSE 폴백) 입니다.

`agents.defaults.models.<provider/model>.params.transport` 를 설정할 수 있습니다:

- `"sse"`: SSE 강제
- `"websocket"`: WebSocket 강제
- `"auto"`: WebSocket 시도 후 SSE 로 폴백

`openai/*` (Responses API) 의 경우, OpenClaw 는 WebSocket 전송 사용 시 기본적으로 WebSocket 워밍업도 활성화합니다 (`openaiWsWarmup: true`).

관련 OpenAI 문서:

- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocket 워밍업

OpenAI 문서에서는 워밍업을 선택 사항으로 설명합니다. OpenClaw 는 WebSocket 전송 사용 시 첫 번째 턴 지연을 줄이기 위해 `openai/*` 에 대해 기본적으로 활성화합니다.

### 워밍업 비활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### 워밍업 명시적 활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI 우선 처리

OpenAI 의 API 는 `service_tier=priority` 를 통해 우선 처리를 노출합니다. OpenClaw 에서 `agents.defaults.models["openai/<model>"].params.serviceTier` 를 설정하여 직접 `openai/*` Responses 요청에 해당 필드를 전달합니다.

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

지원되는 값은 `auto`, `default`, `flex`, `priority` 입니다.

### OpenAI fast 모드

OpenClaw 는 `openai/*` 와 `openai-codex/*` 세션 모두에 대한 공유 fast 모드 토글을 노출합니다:

- 채팅/UI: `/fast status|on|off`
- 설정: `agents.defaults.models["<provider>/<model>"].params.fastMode`

fast 모드가 활성화되면, OpenClaw 는 저지연 OpenAI 프로필을 적용합니다:

- 페이로드에 이미 reasoning 이 지정되어 있지 않으면 `reasoning.effort = "low"`
- 페이로드에 이미 verbosity 가 지정되어 있지 않으면 `text.verbosity = "low"`
- `api.openai.com` 에 대한 직접 `openai/*` Responses 호출에 `service_tier = "priority"`

예제:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

세션 재정의가 설정보다 우선합니다. Sessions UI 에서 세션 재정의를 지우면 세션이 설정된 기본값으로 돌아갑니다.

### OpenAI Responses 서버 측 압축

직접 OpenAI Responses 모델 (`api.openai.com` 의 `baseUrl` 을 가진 `api: "openai-responses"` 를 사용하는 `openai/*`) 의 경우, OpenClaw 는 이제 OpenAI 서버 측 압축 페이로드 힌트를 자동 활성화합니다:

- `store: true` 강제 (모델 호환성이 `supportsStore: false` 를 설정하지 않는 한)
- `context_management: [{ type: "compaction", compact_threshold: ... }]` 주입

기본적으로 `compact_threshold` 는 모델 `contextWindow` 의 `70%` (사용할 수 없는 경우 `80000`) 입니다.

### 서버 측 압축 명시적 활성화

호환 Responses 모델 (예: Azure OpenAI Responses) 에서 `context_management` 주입을 강제하려면 이를 사용하세요:

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### 사용자 정의 임계값으로 활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### 서버 측 압축 비활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` 은 `context_management` 주입만 제어합니다.
직접 OpenAI Responses 모델은 호환성이 `supportsStore: false` 를 설정하지 않는 한 여전히 `store: true` 를 강제합니다.

## 참고 사항

- 모델 참조는 항상 `provider/model` 형식을 사용합니다 ([/concepts/models](/concepts/models) 참조).
- 인증 세부 사항 및 재사용 규칙은 [/concepts/oauth](/concepts/oauth) 에 있습니다.
