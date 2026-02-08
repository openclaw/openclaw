---
read_when:
    - OpenClaw에서 Xiaomi MiMo 모델을 원합니다
    - XIAOMI_API_KEY 설정이 필요합니다
summary: OpenClaw와 함께 Xiaomi MiMo(mimo-v2-flash) 사용
title: 샤오미 미모
x-i18n:
    generated_at: "2026-02-08T16:01:03Z"
    model: gtx
    provider: google-translate
    source_hash: 366fd2297b2caf8c5ad944d7f1b6d233b248fe43aedd22a28352ae7f370d2435
    source_path: providers/xiaomi.md
    workflow: 15
---

# 샤오미 미모

Xiaomi MiMo는 다음을 위한 API 플랫폼입니다. **미모** 모델. 호환되는 REST API를 제공합니다.
OpenAI 및 Anthropic 형식을 지정하고 인증을 위해 API 키를 사용합니다. API 키를 생성하세요
는 [샤오미 MiMo 콘솔](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw는 다음을 사용합니다.
는 `xiaomi` Xiaomi MiMo API 키를 제공하는 공급자입니다.

## 모델 개요

- **mimo-v2-플래시**: 262144-토큰 컨텍스트 창, Anthropic Messages API와 호환됩니다.
- 기본 URL: `https://api.xiaomimimo.com/anthropic`
- 권한 부여: `Bearer $XIAOMI_API_KEY`

## CLI 설정

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 구성 스니펫

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
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
        ],
      },
    },
  },
}
```

## 메모

- 모델 참조: `xiaomi/mimo-v2-flash`.
- 공급자는 다음과 같은 경우 자동으로 주입됩니다. `XIAOMI_API_KEY` 설정되었습니다(또는 인증 프로필이 존재함).
- 보다 [/개념/모델 제공자](/concepts/model-providers) 공급자 규칙의 경우.
