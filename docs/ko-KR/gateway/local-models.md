---
summary: "OpenClaw을 로컬 LLM (LM Studio, vLLM, LiteLLM, 커스텀 OpenAI 엔드포인트)에서 실행"
read_when:
  - 자체 GPU 박스에서 모델을 서빙하고 싶을 때
  - LM Studio 또는 OpenAI 호환 프록시를 연결할 때
  - 가장 안전한 로컬 모델 가이드가 필요할 때
title: "로컬 모델"
x-i18n:
  source_path: docs/gateway/local-models.md
---

# 로컬 모델

로컬 실행은 가능하지만, OpenClaw은 큰 컨텍스트와 프롬프트 인젝션에 대한 강력한 방어를 기대합니다. 작은 카드는 컨텍스트를 잘라내고 안전성이 떨어집니다. 높게 목표하세요: **2대 이상의 최대 사양 Mac Studio 또는 동급 GPU 장비 (~$30k+)**. 단일 **24 GB** GPU는 더 높은 지연 시간으로 가벼운 프롬프트에만 작동합니다. 실행할 수 있는 **가장 크고/전체 크기의 모델 변형**을 사용하세요. 공격적으로 양자화된 또는 "small" 체크포인트는 프롬프트 인젝션 위험을 높입니다 ([보안](/gateway/security) 참고).

가장 마찰이 적은 로컬 설정을 원하면 [Ollama](/providers/ollama)와 `openclaw onboard`로 시작하세요. 이 페이지는 고급 로컬 스택과 커스텀 OpenAI 호환 로컬 서버를 위한 의견이 담긴 가이드입니다.

## 권장: LM Studio + MiniMax M2.5 (Responses API, 전체 크기)

현재 최고의 로컬 스택입니다. LM Studio에서 MiniMax M2.5를 로드하고, 로컬 서버를 활성화하고 (기본값 `http://127.0.0.1:1234`), Responses API를 사용하여 추론을 최종 텍스트와 분리합니다.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**설정 체크리스트**

- LM Studio 설치: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio에서 **사용 가능한 가장 큰 MiniMax M2.5 빌드**를 다운로드하고 ("small"/과도하게 양자화된 변형 피하기), 서버를 시작하고, `http://127.0.0.1:1234/v1/models`에 나열되는지 확인합니다.
- 모델을 로드된 상태로 유지합니다. 콜드 로드는 시작 지연을 추가합니다.
- LM Studio 빌드가 다르면 `contextWindow`/`maxTokens`를 조정합니다.
- WhatsApp의 경우, Responses API를 유지하여 최종 텍스트만 전송되도록 합니다.

로컬 실행 시에도 호스팅 모델을 설정된 상태로 유지합니다. `models.mode: "merge"`를 사용하여 폴백이 계속 사용 가능하도록 합니다.

### 하이브리드 설정: 호스팅 기본, 로컬 폴백

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["lmstudio/minimax-m2.5-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/minimax-m2.5-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### 로컬 우선 + 호스팅 안전망

기본과 폴백 순서를 바꿉니다. 동일한 프로바이더 블록과 `models.mode: "merge"`를 유지하여 로컬 박스가 다운될 때 Sonnet이나 Opus로 폴백할 수 있습니다.

### 지역 호스팅 / 데이터 라우팅

- 호스팅된 MiniMax/Kimi/GLM 변형도 지역 고정 엔드포인트로 OpenRouter에 존재합니다 (예: 미국 호스팅). 해당 지역 변형을 선택하여 `models.mode: "merge"`를 사용한 Anthropic/OpenAI 폴백을 유지하면서 선택한 관할 지역에 트래픽을 유지합니다.
- 로컬 전용이 가장 강력한 프라이버시 경로입니다. 호스팅 지역 라우팅은 프로바이더 기능이 필요하지만 데이터 흐름을 제어하고 싶을 때의 중간 지점입니다.

## 기타 OpenAI 호환 로컬 프록시

vLLM, LiteLLM, OAI-proxy 또는 커스텀 Gateway는 OpenAI 스타일 `/v1` 엔드포인트를 노출하면 작동합니다. 위의 프로바이더 블록을 엔드포인트와 모델 ID로 대체합니다:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

호스팅 모델이 폴백으로 계속 사용 가능하도록 `models.mode: "merge"`를 유지합니다.

## 문제 해결

- Gateway가 프록시에 접근할 수 있나요? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio 모델이 언로드되었나요? 리로드합니다. 콜드 스타트는 "멈춤"의 일반적인 원인입니다.
- 컨텍스트 오류? `contextWindow`를 낮추거나 서버 제한을 높입니다.
- 안전: 로컬 모델은 프로바이더 측 필터를 건너뜁니다. 에이전트를 좁게 유지하고 압축을 켜서 프롬프트 인젝션 폭발 반경을 제한합니다.
