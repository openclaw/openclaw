---
summary: "OpenClaw 에서 Z.AI (GLM 모델) 사용하기"
read_when:
  - OpenClaw 에서 Z.AI / GLM 모델을 사용하고 싶을 때
  - 간단한 ZAI_API_KEY 설정이 필요할 때
title: "Z.AI"
x-i18n:
  source_path: docs/providers/zai.md
---

# Z.AI

Z.AI 는 **GLM** 모델을 위한 API 플랫폼입니다. GLM 을 위한 REST API 를 제공하며 인증에 API 키를 사용합니다. Z.AI 콘솔에서 API 키를 생성하세요. OpenClaw 는 Z.AI API 키와 함께 `zai` 프로바이더를 사용합니다.

## CLI 설정

```bash
# Coding Plan Global, Coding Plan 사용자에게 권장
openclaw onboard --auth-choice zai-coding-global

# Coding Plan CN (중국 리전), Coding Plan 사용자에게 권장
openclaw onboard --auth-choice zai-coding-cn

# General API
openclaw onboard --auth-choice zai-global

# General API CN (중국 리전)
openclaw onboard --auth-choice zai-cn
```

## 설정 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 참고 사항

- GLM 모델은 `zai/<model>` 로 사용할 수 있습니다 (예: `zai/glm-5`).
- `tool_stream` 은 Z.AI 도구 호출 스트리밍에 대해 기본적으로 활성화됩니다. 비활성화하려면
  `agents.defaults.models["zai/<model>"].params.tool_stream` 을 `false` 로 설정하세요.
- 모델 패밀리 개요는 [/providers/glm](/providers/glm) 을 참조하세요.
- Z.AI 는 API 키와 함께 Bearer 인증을 사용합니다.
