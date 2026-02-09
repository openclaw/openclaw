---
summary: "OpenClaw 에서 여러 모델에 접근하기 위해 OpenRouter 의 통합 API 를 사용합니다"
read_when:
  - 여러 LLM 에 대해 단일 API 키를 원할 때
  - OpenClaw 에서 OpenRouter 를 통해 모델을 실행하려는 경우
title: "OpenRouter"
---

# OpenRouter

OpenRouter 는 단일 엔드포인트와 API 키 뒤에서 여러 모델로 요청을 라우팅하는 **통합 API** 를 제공합니다. OpenAI 호환이므로, 대부분의 OpenAI SDK 는 기본 URL 만 전환하면 작동합니다.

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
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## 참고 사항

- 모델 참조는 `openrouter/<provider>/<model>` 입니다.
- 더 많은 모델 및 프로바이더 옵션은 [/concepts/model-providers](/concepts/model-providers) 를 참고하십시오.
- OpenRouter 는 내부적으로 API 키를 Bearer 토큰으로 사용합니다.
