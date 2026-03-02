---
summary: "OpenClaw에서 많은 모델에 액세스하기 위해 OpenRouter의 통합 API를 사용합니다"
read_when:
  - 많은 LLM을 위해 단일 API 키를 원할 때
  - OpenClaw에서 OpenRouter를 통해 모델을 실행하려고 할 때
title: "OpenRouter"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/openrouter.md"
  workflow: 15
---

# OpenRouter

OpenRouter는 단일 엔드포인트 및 API 키 뒤의 많은 모델로 요청을 라우팅하는 **통합 API**를 제공합니다. OpenAI 호환이므로 대부분의 OpenAI SDK는 기본 URL을 전환하여 작동합니다.

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

## 참고

- 모델 참조는 `openrouter/<provider>/<model>`입니다.
- 더 많은 모델/제공업체 옵션은 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
- OpenRouter는 후드 아래에서 API 키가 있는 Bearer 토큰을 사용합니다.
