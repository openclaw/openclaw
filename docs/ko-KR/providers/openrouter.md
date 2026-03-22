---
summary: "OpenClaw 에서 OpenRouter 의 통합 API 를 사용하여 다양한 모델에 액세스하기"
read_when:
  - 다양한 LLM 에 대한 단일 API 키를 원할 때
  - OpenClaw 에서 OpenRouter 를 통해 모델을 실행하고 싶을 때
title: "OpenRouter"
x-i18n:
  source_path: docs/providers/openrouter.md
---

# OpenRouter

OpenRouter 는 단일 엔드포인트와 API 키 뒤에서 많은 모델로 요청을 라우팅하는 **통합 API** 를 제공합니다. OpenAI 호환이므로 대부분의 OpenAI SDK 가 기본 URL 만 변경하면 작동합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
    },
  },
}
```

## 참고 사항

- 모델 참조는 `openrouter/<provider>/<model>` 형식입니다.
- 추가 모델/프로바이더 옵션은 [/concepts/model-providers](/concepts/model-providers) 를 참조하세요.
- OpenRouter 는 내부적으로 API 키와 함께 Bearer 토큰을 사용합니다.
