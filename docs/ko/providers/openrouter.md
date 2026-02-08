---
read_when:
    - 많은 LLM에 대해 단일 API 키가 필요합니다.
    - OpenClaw에서 OpenRouter를 통해 모델을 실행하고 싶습니다.
summary: OpenRouter의 통합 API를 사용하여 OpenClaw의 다양한 모델에 액세스
title: 오픈라우터
x-i18n:
    generated_at: "2026-02-08T16:08:03Z"
    model: gtx
    provider: google-translate
    source_hash: b7e29fc9c456c64d567dd909a85166e6dea8388ebd22155a31e69c970e081586
    source_path: providers/openrouter.md
    workflow: 15
---

# 오픈라우터

OpenRouter는 다음을 제공합니다. **통합 API** 단일 모델 뒤에 있는 여러 모델로 요청을 라우팅하는 것입니다.
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

- 모델 참조는 다음과 같습니다. `openrouter/<provider>/<model>`.
- 더 많은 모델/공급자 옵션을 보려면 다음을 참조하세요. [/개념/모델 제공자](/concepts/model-providers).
- OpenRouter는 내부적으로 API 키와 함께 Bearer 토큰을 사용합니다.
