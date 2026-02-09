---
summary: "OpenClaw 에서 Z.AI (GLM 모델) 사용"
read_when:
  - OpenClaw 에서 Z.AI / GLM 모델을 사용하려는 경우
  - 간단한 ZAI_API_KEY 설정이 필요한 경우
title: "Z.AI"
---

# Z.AI

Z.AI 는 **GLM** 모델을 위한 API 플랫폼입니다. GLM 을 위한 REST API 를 제공하며 인증에 API 키를 사용합니다. Z.AI 콘솔에서 API 키를 생성하십시오. OpenClaw 는 Z.AI API 키와 함께 `zai` 프로바이더를 사용합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 참고 사항

- GLM 모델은 `zai/<model>` 로 제공됩니다 (예: `zai/glm-4.7`).
- 모델 패밀리 개요는 [/providers/glm](/providers/glm) 를 참조하십시오.
- Z.AI 는 API 키와 함께 Bearer 인증을 사용합니다.
