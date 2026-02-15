---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - You need the account ID, gateway ID, or API key env var
x-i18n:
  source_hash: db77652c37652ca20f7c50f32382dbaeaeb50ea5bdeaf1d4fd17dc394e58950c
---

# Cloudflare AI 게이트웨이

Cloudflare AI Gateway는 공급자 API 앞에 위치하며 분석, 캐싱, 제어를 추가할 수 있게 해줍니다. Anthropic의 경우 OpenClaw는 게이트웨이 엔드포인트를 통해 Anthropic 메시지 API를 사용합니다.

- 제공자 : `cloudflare-ai-gateway`
- 기본 URL : `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 기본 모델 : `cloudflare-ai-gateway/claude-sonnet-4-5`
- API 키: `CLOUDFLARE_AI_GATEWAY_API_KEY` (게이트웨이를 통한 요청을 위한 공급자 API 키)

Anthropic 모델의 경우 Anthropic API 키를 사용하세요.

## 빠른 시작

1. 공급자 API 키와 게이트웨이 세부정보를 설정합니다.

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## 비대화형 예시

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 인증된 게이트웨이

Cloudflare에서 게이트웨이 인증을 활성화한 경우 `cf-aig-authorization` 헤더를 추가하세요(이는 공급자 API 키에 추가됩니다).

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

## 환경 참고 사항

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우 해당 프로세스에서 `CLOUDFLARE_AI_GATEWAY_API_KEY`를 사용할 수 있는지 확인하세요(예: `~/.openclaw/.env` 또는 `env.shellEnv`를 통해).
