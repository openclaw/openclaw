---
read_when:
    - OpenClaw에서 Z.AI / GLM 모델을 원합니다.
    - 간단한 ZAI_API_KEY 설정이 필요합니다
summary: OpenClaw와 함께 Z.AI(GLM 모델) 사용
title: Z.AI
x-i18n:
    generated_at: "2026-02-08T16:09:30Z"
    model: gtx
    provider: google-translate
    source_hash: 2c24bbad86cf86c38675a58e22f9e1b494f78a18fdc3051c1be80d2d9a800711
    source_path: providers/zai.md
    workflow: 15
---

# Z.AI

Z.AI는 API 플랫폼입니다. **GLM** 모델. GLM용 REST API를 제공하고 API 키를 사용합니다.
인증을 위해. Z.AI 콘솔에서 API 키를 생성하세요. OpenClaw는 다음을 사용합니다. `zai` 공급자
Z.AI API 키를 사용합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 구성 스니펫

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 메모

- GLM 모델은 다음과 같이 제공됩니다. `zai/<model>` (예: `zai/glm-4.7`).
- 보다 [/공급자/glm](/providers/glm) 모델 패밀리 개요를 확인하세요.
- Z.AI는 API 키와 함께 Bearer 인증을 사용합니다.
