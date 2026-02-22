---
summary: "GLM 모델 패밀리 개요 + OpenClaw에서 사용하는 방법"
read_when:
  - OpenClaw에서 GLM 모델을 원할 때
  - 모델 명명 규칙과 설정이 필요할 때
title: "GLM 모델"
---

# GLM 모델

GLM은 Z.AI 플랫폼을 통해 제공되는 **모델 패밀리** (회사가 아님)입니다. OpenClaw에서는 `zai` 프로바이더와 `zai/glm-5`와 같은 모델 ID를 통해 GLM 모델에 액세스합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
```

## 설정 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 주의사항

- GLM 버전과 가용성은 변경될 수 있으며, 최신 정보를 위해 Z.AI의 문서를 확인하세요.
- 예시 모델 ID에는 `glm-5`, `glm-4.7` 및 `glm-4.6`이 포함됩니다.
- 프로바이더에 대한 자세한 정보는 [/providers/zai](/ko-KR/providers/zai)를 참조하세요.