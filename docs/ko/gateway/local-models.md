---
read_when:
    - 자체 GPU 상자에서 모델을 제공하고 싶습니다.
    - LM Studio 또는 OpenAI 호환 프록시를 연결하고 있습니다.
    - 가장 안전한 현지 모델 안내가 필요합니다
summary: 로컬 LLM(LM Studio, vLLM, LiteLLM, 사용자 정의 OpenAI 엔드포인트)에서 OpenClaw 실행
title: 지역 모델
x-i18n:
    generated_at: "2026-02-08T15:55:12Z"
    model: gtx
    provider: google-translate
    source_hash: 82164e8c4f0c74797a6d3da784e5cc494b5bc419169a27fc21a588aa8c9e569a
    source_path: gateway/local-models.md
    workflow: 15
---

# 현지 모델

로컬은 가능하지만 OpenClaw는 대규모 컨텍스트와 즉각적인 주입에 대한 강력한 방어를 기대합니다. 작은 카드는 컨텍스트와 누출 안전성을 줄입니다. 높은 목표: **≥2개 최대 성능의 Mac Studio 또는 동급 GPU 장비(~$30,000+)**. 싱글 **24GB** GPU는 대기 시간이 길고 가벼운 프롬프트에서만 작동합니다. 사용 **실행할 수 있는 가장 큰/풀 사이즈 모델 변형**; 공격적으로 수량화되거나 "작은" 체크포인트는 신속한 주입 위험을 높입니다(참조: [보안](/gateway/security)).

## 권장: LM Studio + MiniMax M2.1(Responses API, 전체 크기)

현재 최고의 로컬 스택. LM Studio에서 MiniMax M2.1을 로드하고 로컬 서버를 활성화합니다(기본값) `http://127.0.0.1:1234`), Responses API를 사용하여 추론을 최종 텍스트와 별도로 유지합니다.

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

- LM 스튜디오를 설치합니다: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio에서 **가장 큰 MiniMax M2.1 빌드 가능** (“작은”/과도하게 양자화된 변형은 피함), 서버를 시작하고, 확인하세요. `http://127.0.0.1:1234/v1/models` 그것을 나열합니다.
- 모델을 로드된 상태로 유지하세요. 콜드 로드는 시작 대기 시간을 추가합니다.
- 조정하다 `contextWindow`/`maxTokens` LM Studio 빌드가 다른 경우.
- WhatsApp의 경우 최종 텍스트만 전송되도록 Responses API를 사용하세요.

로컬로 실행하는 경우에도 호스팅 모델 구성을 유지합니다. 사용 `models.mode: "merge"` 따라서 대체 기능은 계속 사용할 수 있습니다.

### 하이브리드 구성: 호스팅된 기본, 로컬 대체

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

### 호스팅된 안전망을 통한 로컬 우선

기본 순서와 대체 순서를 바꿉니다. 동일한 공급자를 차단하고 `models.mode: "merge"` 로컬 박스가 다운되면 Sonnet이나 Opus로 돌아갈 수 있습니다.

### 지역 호스팅/데이터 라우팅

- 호스팅된 MiniMax/Kimi/GLM 변형은 지역 고정 엔드포인트(예: 미국 호스팅)가 있는 OpenRouter에도 존재합니다. 계속 사용하는 동안 선택한 관할권에서 트래픽을 유지하려면 지역 변형을 선택하세요. `models.mode: "merge"` Anthropic/OpenAI 대체용.
- 로컬 전용은 여전히 ​​가장 강력한 개인 정보 보호 경로입니다. 호스팅된 지역 라우팅은 공급자 기능이 필요하지만 데이터 흐름을 제어하려는 경우 중간 지점입니다.

## 기타 OpenAI 호환 로컬 프록시

vLLM, LiteLLM, OAI 프록시 또는 사용자 지정 게이트웨이는 OpenAI 스타일을 노출하는 경우 작동합니다. `/v1` 끝점. 위의 공급자 블록을 엔드포인트 및 모델 ID로 바꿉니다.

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

유지하다 `models.mode: "merge"` 따라서 호스팅된 모델은 대체 항목으로 계속 사용할 수 있습니다.

## 문제 해결

- 게이트웨이가 프록시에 연결할 수 있습니까? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio 모델이 언로드되었나요? 새로고침; 콜드 스타트는 일반적인 "정지" 원인입니다.
- 컨텍스트 오류? 낮추다 `contextWindow` 아니면 서버 한도를 높이세요.
- 안전성: 로컬 모델은 공급자 측 필터를 건너뜁니다. 신속한 주입 폭발 반경을 제한하려면 약제를 좁게 하고 압축을 유지하십시오.
