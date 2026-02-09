---
summary: "로컬 LLM (LM Studio, vLLM, LiteLLM, 사용자 지정 OpenAI 엔드포인트)에서 OpenClaw 실행"
read_when:
  - 자체 GPU 박스에서 모델을 제공하려는 경우
  - LM Studio 또는 OpenAI 호환 프록시를 연결하는 경우
  - 가장 안전한 로컬 모델 가이던스가 필요한 경우
title: "로컬 모델"
---

# 로컬 모델

로컬 실행은 가능하지만, OpenClaw 는 큰 컨텍스트와 프롬프트 인젝션에 대한 강력한 방어를 기대합니다. 소형 카드에서는 컨텍스트가 잘리고 안전 장치가 누출됩니다. 목표는 높게 잡으십시오: **최대 사양의 Mac Studio ≥2대 또는 동급 GPU 리그 (~$30k+)**. 단일 **24 GB** GPU 는 지연 시간이 늘어난 가벼운 프롬프트에서만 작동합니다. 실행 가능한 **가장 큰 / 풀 사이즈 모델 변형**을 사용하십시오. 과도하게 양자화되었거나 '소형' 체크포인트는 프롬프트 인젝션 위험을 높입니다( [Security](/gateway/security) 참고).

## 권장: LM Studio + MiniMax M2.1 (Responses API, 풀 사이즈)

현재 최고의 로컬 스택입니다. LM Studio 에서 MiniMax M2.1 을 로드하고 로컬 서버(기본값 `http://127.0.0.1:1234`)를 활성화한 다음, Responses API 를 사용하여 추론과 최종 텍스트를 분리하십시오.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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
- LM Studio 에서 **사용 가능한 가장 큰 MiniMax M2.1 빌드**를 다운로드하고('small'/과도한 양자화 변형은 피하십시오), 서버를 시작한 뒤 `http://127.0.0.1:1234/v1/models` 에 표시되는지 확인합니다.
- 모델을 로드된 상태로 유지하십시오. 콜드 로드는 시작 지연을 추가합니다.
- LM Studio 빌드가 다를 경우 `contextWindow`/`maxTokens` 을 조정하십시오.
- WhatsApp 의 경우, 최종 텍스트만 전송되도록 Responses API 를 사용하십시오.

로컬 실행 중에도 호스티드 모델을 구성해 두십시오. `models.mode: "merge"` 을 사용하여 폴백을 계속 사용할 수 있습니다.

### 하이브리드 구성: 호스티드 기본, 로컬 폴백

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

### 로컬 우선 + 호스티드 안전망

기본과 폴백 순서를 바꾸십시오. 동일한 providers 블록과 `models.mode: "merge"` 을 유지하여 로컬 박스가 다운될 때 Sonnet 또는 Opus 로 폴백할 수 있도록 합니다.

### 지역 호스팅 / 데이터 라우팅

- OpenRouter 에는 지역 고정 엔드포인트(예: US 호스팅)가 있는 호스티드 MiniMax/Kimi/GLM 변형도 있습니다. 선택한 관할권 내로 트래픽을 유지하려면 해당 지역 변형을 선택하고, Anthropic/OpenAI 폴백에는 `models.mode: "merge"` 을 사용하십시오.
- 로컬 전용은 가장 강력한 프라이버시 경로입니다. 호스티드 지역 라우팅은 프로바이더 기능이 필요하지만 데이터 흐름을 제어하고자 할 때의 중간 지점입니다.

## 기타 OpenAI 호환 로컬 프록시

vLLM, LiteLLM, OAI-proxy 또는 사용자 지정 게이트웨이는 OpenAI 스타일의 `/v1` 엔드포인트를 노출하면 작동합니다. 위의 provider 블록을 자신의 엔드포인트와 모델 ID 로 교체하십시오:

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

호스티드 모델을 폴백으로 유지하려면 `models.mode: "merge"` 을 유지하십시오.

## 문제 해결

- Gateway(게이트웨이) 가 프록시에 도달합니까? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio 모델이 언로드되었습니까? Reload; cold start is a common “hanging” cause.
- 컨텍스트 오류가 발생합니까? `contextWindow` 을 낮추거나 서버 한도를 높이십시오.
- 안전성: 로컬 모델은 프로바이더 측 필터를 건너뜁니다. 에이전트를 좁게 유지하고 컴팩션을 켜서 프롬프트 인젝션의 영향 범위를 제한하십시오.
