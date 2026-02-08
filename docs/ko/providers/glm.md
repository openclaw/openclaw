---
read_when:
    - OpenClaw에서 GLM 모델을 원합니다.
    - 모델 명명 규칙 및 설정이 필요합니다.
summary: GLM 모델 제품군 개요 + OpenClaw에서 사용하는 방법
title: GLM 모델
x-i18n:
    generated_at: "2026-02-08T16:08:00Z"
    model: gtx
    provider: google-translate
    source_hash: 2d7b457f033f26f28c230a9cd2310151f825fc52c3ee4fb814d08fd2d022d041
    source_path: providers/glm.md
    workflow: 15
---

# GLM 모델

GLM은 **모델 가족** (회사 아님) Z.AI 플랫폼을 통해 이용 가능합니다. OpenClaw에서는 GLM
모델은 다음을 통해 액세스됩니다. `zai` 다음과 같은 공급자 및 모델 ID `zai/glm-4.7`.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
```

## 구성 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 메모

- GLM 버전 및 가용성은 변경될 수 있습니다. 최신 내용은 Z.AI의 문서를 확인하세요.
- 모델 ID의 예는 다음과 같습니다. `glm-4.7` 그리고 `glm-4.6`.
- 공급자 세부정보는 다음을 참조하세요. [/공급자/자이](/providers/zai).
