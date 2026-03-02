---
summary: "GLM 모델 제품군 개요 + OpenClaw에서 사용하는 방법"
read_when:
  - OpenClaw에서 GLM 모델을 사용하고 싶을 때
  - 모델 명명 규칙 및 설정이 필요할 때
title: "GLM 모델"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/glm.md"
  workflow: 15
---

# GLM 모델

GLM은 Z.AI 플랫폼을 통해 사용 가능한 **모델 제품군** (회사 아님)입니다. OpenClaw에서 GLM 모델은 `zai` 제공자를 통해 액세스되며 `zai/glm-5` 같은 모델 ID를 사용합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
```

## 구성 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 참고

- GLM 버전 및 가용성은 변할 수 있습니다. Z.AI의 최신 문서를 확인합니다.
- 예제 모델 ID에는 `glm-5`, `glm-4.7`, `glm-4.6`이 포함됩니다.
- 제공자 세부사항은 [/providers/zai](/providers/zai)를 참조하세요.
