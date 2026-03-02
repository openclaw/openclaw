---
summary: "OpenClaw에서 API 키 또는 Codex 구독으로 OpenAI를 사용합니다"
read_when:
  - OpenClaw에서 OpenAI 모델을 사용하고 싶을 때
  - API 키 대신 Codex 구독 인증을 원할 때
title: "OpenAI"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/openai.md"
  workflow: 15
---

# OpenAI

OpenAI는 GPT 모델을 위한 개발자 API를 제공합니다. Codex는 구독 액세스를 위한 **ChatGPT 로그인** 또는 사용량 기반 액세스를 위한 **API 키** 로그인을 지원합니다. Codex 클라우드는 ChatGPT 로그인이 필요합니다.

## 옵션 A: OpenAI API 키 (OpenAI 플랫폼)

**최고:** 직접 API 액세스 및 사용량 기반 청구.
OpenAI 대시보드에서 API 키를 가져옵니다.

### CLI 설정

```bash
openclaw onboard --auth-choice openai-api-key
# 또는 비대화형
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 구성 스니펫

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## 옵션 B: OpenAI Code (Codex) 구독

**최고:** API 키 대신 ChatGPT/Codex 구독 액세스를 사용합니다.
Codex 클라우드는 ChatGPT 로그인이 필요하며, Codex CLI는 ChatGPT 또는 API 키 로그인을 지원합니다.

### CLI 설정 (Codex OAuth)

```bash
# 마법사에서 Codex OAuth 실행
openclaw onboard --auth-choice openai-codex

# 또는 OAuth를 직접 실행
openclaw models auth login --provider openai-codex
```

### 구성 스니펫 (Codex 구독)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### 전송 기본값

OpenClaw는 모델 스트리밍을 위해 `pi-ai`를 사용합니다. `openai/*` 및 `openai-codex/*` 모두에 대해 기본 전송은 `"auto"` (WebSocket 우선, SSE 폴백)입니다.

`agents.defaults.models.<provider/model>.params.transport`를 설정할 수 있습니다:

- `"sse"`: SSE 강제
- `"websocket"`: WebSocket 강제
- `"auto"`: WebSocket 시도, SSE로 폴백

`openai/*` (Responses API)의 경우 OpenClaw는 WebSocket 전송을 사용할 때 기본적으로 WebSocket 워밍업을 활성화합니다(`openaiWsWarmup: true`).

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.3-codex" },
      models: {
        "openai-codex/gpt-5.3-codex": {
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

OpenAI 문서에서는 워밍업이 선택 사항입니다. OpenClaw는 WebSocket 전송을 사용할 때 첫 번째 턴 지연을 줄이기 위해 `openai/*`에 대해 기본적으로 활성화합니다.

### 워밍업 비활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### 명시적으로 워밍업 활성화

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI Responses 서버 측 압축

OpenAI Responses 모델(`openai/*`을 사용하여 `api: "openai-responses"`와 `baseUrl`을 `api.openai.com`에)의 경우 OpenClaw는 이제 자동으로 OpenAI 서버 측 압축 페이로드 힌트를 활성화합니다:

- `store: true` 강제 (모델 호환성이 `supportsStore: false`를 설정하지 않는 한)
- `context_management: [{ type: "compaction", compact_threshold: ... }]` 주입

기본적으로 `compact_threshold`는 모델 `contextWindow`의 `70%` (또는 사용할 수 없을 때 `80000`)입니다.

### 서버 측 압축 명시적으로 활성화

호환되는 Responses 모델 (예: Azure OpenAI Responses)에서 `context_management` 주입을 강제할 때 사용합니다:

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-4o": {
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
        "openai/gpt-5": {
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
        "openai/gpt-5": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction`은 `context_management` 주입만 제어합니다.
OpenAI Responses 모델은 호환성이 `supportsStore: false`를 설정하지 않는 한 여전히 `store: true`를 강제합니다.

## 참고

- 모델 참조는 항상 `provider/model`입니다([/concepts/models](/concepts/models) 참조).
- 인증 세부사항 및 재사용 규칙은 [/concepts/oauth](/concepts/oauth)에 있습니다.
