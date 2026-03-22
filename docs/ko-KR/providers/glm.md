---
summary: "GLM 모델 패밀리 개요 + OpenClaw 에서 사용하는 방법"
read_when:
  - OpenClaw 에서 GLM 모델을 사용하고 싶을 때
  - 모델 명명 규칙과 설정이 필요할 때
title: "GLM 모델"
x-i18n:
  source_path: docs/providers/glm.md
---

# GLM 모델

GLM 은 Z.AI 플랫폼을 통해 사용할 수 있는 **모델 패밀리** (회사가 아님) 입니다. OpenClaw 에서 GLM 모델은 `zai` 프로바이더를 통해 액세스하며 `zai/glm-5` 와 같은 모델 ID 를 사용합니다.

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

- GLM 버전 및 가용성은 변경될 수 있습니다. 최신 정보는 Z.AI 문서를 확인하세요.
- 예제 모델 ID 에는 `glm-5`, `glm-4.7`, `glm-4.6` 이 포함됩니다.
- 프로바이더 세부 정보는 [/providers/zai](/providers/zai) 를 참조하세요.
