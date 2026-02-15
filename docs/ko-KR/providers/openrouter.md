---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
title: "OpenRouter"
x-i18n:
  source_hash: b7e29fc9c456c64d567dd909a85166e6dea8388ebd22155a31e69c970e081586
---

# 오픈라우터

OpenRouter는 요청을 단일 모델 뒤의 여러 모델로 라우팅하는 **통합 API**를 제공합니다.
엔드포인트 및 API 키. OpenAI와 호환되므로 대부분의 OpenAI SDK는 기본 URL을 전환하여 작동합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 구성 스니펫

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

## 메모

- 모델 참조는 `openrouter/<provider>/<model>`입니다.
- 더 많은 모델/공급자 옵션은 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
- OpenRouter는 내부적으로 API 키와 함께 Bearer 토큰을 사용합니다.
