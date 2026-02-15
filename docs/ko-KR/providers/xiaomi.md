---
summary: "Use Xiaomi MiMo (mimo-v2-flash) with OpenClaw"
read_when:
  - You want Xiaomi MiMo models in OpenClaw
  - You need XIAOMI_API_KEY setup
title: "Xiaomi MiMo"
x-i18n:
  source_hash: 366fd2297b2caf8c5ad944d7f1b6d233b248fe43aedd22a28352ae7f370d2435
---

# 샤오미 미모

Xiaomi MiMo는 **MiMo** 모델용 API 플랫폼입니다. 호환되는 REST API를 제공합니다.
OpenAI 및 Anthropic 형식을 지정하고 인증을 위해 API 키를 사용합니다. API 키를 생성하세요
[Xiaomi MiMo 콘솔](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw는 다음을 사용합니다.
Xiaomi MiMo API 키가 있는 `xiaomi` 공급자.

## 모델 개요

- **mimo-v2-flash**: 262144-토큰 컨텍스트 창, Anthropic Messages API와 호환됩니다.
- 기본 URL : `https://api.xiaomimimo.com/anthropic`
- 승인: `Bearer $XIAOMI_API_KEY`

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
- `XIAOMI_API_KEY`이 설정되면(또는 인증 프로필이 존재하는 경우) 공급자가 자동으로 주입됩니다.
- 공급자 규칙은 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
