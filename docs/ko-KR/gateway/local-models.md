---
summary: "로컬 LLM에서 OpenClaw 실행(LM Studio, vLLM, LiteLLM, 커스텀 OpenAI 끝점)"
read_when:
  - 자신의 GPU 상자에서 모델을 제공하려는 경우
  - LM Studio 또는 OpenAI 호환 프록시를 연결 중
  - 가장 안전한 로컬 모델 지침이 필요한 경우
title: "로컬 모델"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/local-models.md
  workflow: 15
---

# 로컬 모델

로컬은 가능하지만 OpenClaw는 큰 컨텍스트 + 프롬프트 주입에 대한 강력한 방어를 기대합니다. 작은 카드는 컨텍스트를 자르고 안전을 누수합니다. 높은 것을 목표로 하세요: **≥2 최대 Mac Studio 또는 동등한 GPU 리그(~$30k+)**. 단일 **24GB** GPU는 더 높은 지연이 있는 더 가벼운 프롬프트에서만 작동합니다. 실행할 수 있는 **최대 / 전체 크기 모델 변형을 사용**; 공격적으로 양자화되거나 "작은" 체크포인트는 프롬프트 주입 위험을 증가시킵니다([Security](/gateway/security) 참조).

## 권장: LM Studio + MiniMax M2.1(Responses API, 전체 크기)

현재 최고의 로컬 스택. MiniMax M2.1을 LM Studio에 로드, 로컬 서버 활성화(기본값 `http://127.0.0.1:1234`) 및 Responses API를 사용하여 추론을 최종 텍스트에서 분리합니다.

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
- LM Studio에서 **가장 큰 MiniMax M2.1 빌드 다운로드**(양자화 경량 변형 피하기), 서버 시작, `http://127.0.0.1:1234/v1/models` 나열 확인.
- 모델을 로드 상태로 유지; 콜드로드는 시작 지연을 추가합니다.
- LM Studio 빌드가 다르면 `contextWindow`/`maxTokens` 조정.
- WhatsApp의 경우 Responses API를 사용하여 최종 텍스트만 전송되도록 합니다.

로컬을 실행할 때도 호스트된 모델을 구성해 유지하세요. `models.mode: "merge"`를 사용하여 폴백이 사용 가능 상태를 유지합니다.

### 하이브리드 설정: 호스트된 주요, 로컬 폴백

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

### 로컬 우선 호스트된 안전망

주요 및 폴백 순서를 스왑하세요; `models.mode: "merge"`를 사용하여 동일한 공급자 블록 및 로컬 박스가 다운될 때 Sonnet 또는 Opus로 폴백할 수 있도록 유지합니다.

### 지역 호스팅 / 데이터 라우팅

- 호스트된 MiniMax/Kimi/GLM 변형도 지역별 끝점이 있는 OpenRouter에 존재합니다(예: US 호스트). 관할권 내에서 트래픽을 유지하면서 `models.mode: "merge"`를 사용하여 Anthropic/OpenAI 폴백을 유지하기 위해 지역 변형을 선택하세요.
- 로컬만유지는 가장 강력한 개인정보 보호 경로입니다. 호스트된 지역 라우팅은 공급자 기능이 필요하지만 데이터 흐름을 제어하려는 경우의 중간 지점입니다.

## 기타 OpenAI 호환 로컬 프록시

vLLM, LiteLLM, OAI-proxy 또는 사용자 정의 게이트웨이는 OpenAI 스타일 `/v1` 끝점을 노출하는 경우 작동합니다. 위의 공급자 블록을 끝점과 모델 ID로 교체합니다:

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

호스트된 모델이 폴백으로 사용 가능하도록 `models.mode: "merge"`를 유지하세요.

## 문제 해결

- 게이트웨이가 프록시에 도달할 수 있습니까? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio 모델이 로드되지 않았습니까? 다시 로드하세요. 콜드 스타트는 일반적인 "걸림" 원인입니다.
- 컨텍스트 오류? `contextWindow`를 낮추거나 서버 제한을 올리세요.
- 안전: 로컬 모델은 공급자 측 필터를 건너뜁니다. 에이전트를 좁게 유지하고 컴팩션을 사용하여 프롬프트 주입 폭발 반경을 제한하세요.
