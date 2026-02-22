---
title: "Cloudflare AI 게이트웨이"
summary: "Cloudflare AI 게이트웨이 설정 (인증 + 모델 선택)"
read_when:
  - Cloudflare AI 게이트웨이를 OpenClaw와 함께 사용하려는 경우
  - 계정 ID, 게이트웨이 ID, API 키 환경 변수가 필요한 경우
---

# Cloudflare AI 게이트웨이

Cloudflare AI 게이트웨이는 프로바이더 API 앞에 위치하여 분석, 캐싱 및 제어 기능을 추가할 수 있게 해줍니다. Anthropic의 경우, OpenClaw는 게이트웨이 엔드포인트를 통해 Anthropic 메시지 API를 사용합니다.

- 프로바이더: `cloudflare-ai-gateway`
- 기본 URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 기본 모델: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API 키: `CLOUDFLARE_AI_GATEWAY_API_KEY` (게이트웨이를 통한 요청을 위한 프로바이더 API 키)

Anthropic 모델을 사용할 경우, Anthropic API 키를 사용하세요.

## 시작하기

1. 프로바이더 API 키 및 게이트웨이 세부정보 설정:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. 기본 모델 설정:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 인증된 게이트웨이

Cloudflare에서 게이트웨이 인증을 활성화한 경우, `cf-aig-authorization` 헤더를 추가해야 합니다 (이것은 프로바이더 API 키와 함께 사용됩니다).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## 환경 관련 주의사항

게이트웨이가 데몬으로 실행되는 경우 (launchd/systemd), `CLOUDFLARE_AI_GATEWAY_API_KEY`가 해당 프로세스에 제공되는지 확인하세요 (예를 들어, `~/.openclaw/.env` 또는 `env.shellEnv`를 통해 설정).
