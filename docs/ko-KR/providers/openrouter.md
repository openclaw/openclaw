---
summary: "OpenClaw의 여러 모델에 접근할 수 있는 OpenRouter의 통합 API 사용"
read_when:
  - 여러 LLM에 대한 단일 API 키를 원할 때
  - OpenClaw에서 OpenRouter를 통해 모델을 실행하고 싶을 때
title: "OpenRouter"
---

# OpenRouter

OpenRouter는 많은 모델에 대한 요청을 단일 엔드포인트와 API 키로 라우팅하는 **통합 API**를 제공합니다. OpenAI와 호환되므로 대부분의 OpenAI SDK는 기본 URL을 변경하여 사용할 수 있습니다.

## CLI 설정

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 설정 코드 조각

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## 주의사항

- 모델 참조는 `openrouter/<provider>/<model>`입니다.
- 더 많은 모델/프로바이더 옵션을 위해서는 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
- OpenRouter는 내부적으로 API 키와 함께 Bearer 토큰을 사용합니다.
