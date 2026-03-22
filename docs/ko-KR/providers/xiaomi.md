---
summary: "OpenClaw 에서 Xiaomi MiMo 모델 사용하기"
read_when:
  - OpenClaw 에서 Xiaomi MiMo 모델을 사용하고 싶을 때
  - XIAOMI_API_KEY 설정이 필요할 때
title: "Xiaomi MiMo"
x-i18n:
  source_path: docs/providers/xiaomi.md
---

# Xiaomi MiMo

Xiaomi MiMo 는 **MiMo** 모델을 위한 API 플랫폼입니다. OpenClaw 는 API 키 인증을 사용하여 Xiaomi OpenAI 호환 엔드포인트를 사용합니다. [Xiaomi MiMo 콘솔](https://platform.xiaomimimo.com/#/console/api-keys) 에서 API 키를 생성한 다음, 해당 키로 번들 `xiaomi` 프로바이더를 설정하세요.

## 모델 개요

- **mimo-v2-flash**: 기본 텍스트 모델, 262144 토큰 컨텍스트 윈도우
- **mimo-v2-pro**: 추론 텍스트 모델, 1048576 토큰 컨텍스트 윈도우
- **mimo-v2-omni**: 텍스트 및 이미지 입력을 지원하는 추론 멀티모달 모델, 262144 토큰 컨텍스트 윈도우
- 기본 URL: `https://api.xiaomimimo.com/v1`
- API: `openai-completions`
- 인증: `Bearer $XIAOMI_API_KEY`

## CLI 설정

```bash
openclaw onboard --auth-choice xiaomi-api-key
# 또는 비대화형으로
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
          {
            id: "mimo-v2-pro",
            name: "Xiaomi MiMo V2 Pro",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 32000,
          },
          {
            id: "mimo-v2-omni",
            name: "Xiaomi MiMo V2 Omni",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

## 참고 사항

- 기본 모델 참조: `xiaomi/mimo-v2-flash`.
- 추가 내장 모델: `xiaomi/mimo-v2-pro`, `xiaomi/mimo-v2-omni`.
- `XIAOMI_API_KEY` 가 설정되면 (또는 인증 프로필이 존재하면) 프로바이더가 자동으로 주입됩니다.
- 프로바이더 규칙은 [/concepts/model-providers](/concepts/model-providers) 를 참조하세요.
