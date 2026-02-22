---
summary: "로컬 LLM (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints)에서 OpenClaw 실행"
read_when:
  - 자체 GPU 박스에서 모델을 서비스하고 싶을 때
  - LM Studio 또는 OpenAI 호환 프록시를 연결 중일 때
  - 가장 안전한 로컬 모델 지침이 필요할 때
title: "로컬 모델"
---

# 로컬 모델

로컬 실행이 가능하지만 OpenClaw는 큰 컨텍스트와 프롬프트 인젝션에 대한 강한 방어를 기대합니다. 작은 카드들은 컨텍스트를 잘라내어 안전성을 누출시킵니다. 목표는 높게 설정: **최소 2대의 최상급 Mac Studio 또는 이에 상응하는 GPU 장비 (~$30k+)**입니다. 단일 **24 GB** GPU는 더 높은 지연시간을 가진 가벼운 프롬프트에만 작동합니다. 실행 가능한 가장 큰/전체 크기 모델 변형을 사용하십시오; 과도하게 양자화되거나 "작은" 체크포인트는 프롬프트 인젝션 위험을 증가시킵니다 ([보안](/ko-KR/gateway/security) 참조).

## 추천: LM Studio + MiniMax M2.1 (Responses API, 전체 크기)

현 시점 최고의 로컬 스택. LM Studio에서 MiniMax M2.1을 로드하고, 로컬 서버를 활성화한 후(기본값 `http://127.0.0.1:1234`), Responses API를 사용하여 추론을 최종 텍스트와 분리합니다.

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
- LM Studio에서 **가장 큰 MiniMax M2.1 빌드를 다운로드**하십시오(작고/과도하게 양자화된 변형 피하기), 서버를 시작하고, `http://127.0.0.1:1234/v1/models`가 이를 나열하는지 확인하세요.
- 모델을 지속적으로 로드한 상태로 유지하세요; 냉로드는 시작 지연을 추가합니다.
- LM Studio 빌드가 다르면 `contextWindow`/`maxTokens`를 조정하세요.
- WhatsApp의 경우, Responses API를 사용하여 최종 텍스트만 전송되도록 하세요.

로컬 실행 중에도 호스팅된 모델을 구성하세요; `models.mode: "merge"`를 사용하여 백업을 유지하세요.

### 하이브리드 설정: 호스팅 기본, 로컬 백업

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

### 로컬 우선, 호스팅 안전망

기본 및 백업 순서를 바꾸십시오; 동일한 프로바이더 블록 및 `models.mode: "merge"`를 유지하여 로컬 박스가 다운될 때 Sonnet 또는 Opus로 백업할 수 있습니다.

### 지역별 호스팅 / 데이터 라우팅

- 호스팅된 MiniMax/Kimi/GLM 변형은 지역 고정 엔드포인트(e.g., US-hosted)와 함께 OpenRouter에 존재합니다. 그곳에서 지역 변형을 선택하여 원하는 관할 구역 내에서 트래픽을 유지하면서 Anthropic/OpenAI 백업을 위해 `models.mode: "merge"`를 사용할 수 있습니다.
- 로컬 전용이 가장 강력한 개인 정보 보호 경로로 남아 있습니다; 호스팅된 지역 라우팅은 프로바이더 기능이 필요하지만 데이터 흐름에 대한 통제를 유지하고 싶을 때 중간 위치에 있습니다.

## 다른 OpenAI 호환 로컬 프록시

vLLM, LiteLLM, OAI-proxy 또는 사용자 정의 게이트웨이는 OpenAI 스타일의 `/v1` 엔드포인트를 노출하면 작동합니다. 위에 있는 프로바이더 블록을 자신의 엔드포인트 및 모델 ID로 교체하십시오:

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

`models.mode: "merge"`를 유지하여 호스팅된 모델이 백업으로 사용 가능하도록 합니다.

## 문제 해결

- 게이트웨이가 프록시에 도달할 수 있습니까? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio 모델이 언로드되었습니까? 다시 로드하십시오; 냉시작은 일반적인 "멈춤" 원인입니다.
- 컨텍스트 오류? `contextWindow`를 낮추거나 서버 한도를 높이십시오.
- 안전성: 로컬 모델은 프로바이더 측 필터를 건너뜁니다; 에이전트를 좁게 유지하고 프롬프트 인젝션 영향 범위를 제한하기 위해 압축을 켜 두십시오.