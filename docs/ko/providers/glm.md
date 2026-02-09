---
summary: "GLM 모델 패밀리 개요 + OpenClaw 에서 사용하는 방법"
read_when:
  - OpenClaw 에서 GLM 모델을 사용하려는 경우
  - 모델 명명 규칙과 설정이 필요한 경우
title: "GLM 모델"
---

# GLM 모델

GLM 은 Z.AI 플랫폼을 통해 제공되는 **모델 패밀리**(회사가 아님)입니다. OpenClaw 에서 GLM
모델은 `zai` 프로바이더와 `zai/glm-4.7` 와 같은 모델 ID 를 통해 접근합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
```

## 설정 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 참고 사항

- GLM 버전과 제공 여부는 변경될 수 있으므로 최신 정보는 Z.AI 문서를 확인하십시오.
- 예시 모델 ID 로는 `glm-4.7` 및 `glm-4.6` 가 있습니다.
- 프로바이더 세부 정보는 [/providers/zai](/providers/zai) 를 참조하십시오.
