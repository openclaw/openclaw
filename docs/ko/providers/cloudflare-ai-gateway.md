---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw 와 함께 Cloudflare AI Gateway 를 사용하려는 경우
  - 계정 ID, Gateway ID 또는 API 키 환경 변수가 필요한 경우
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 는 프로바이더 API 앞단에 위치하여 분석, 캐싱, 제어 기능을 추가할 수 있게 합니다. Anthropic 의 경우 OpenClaw 는 Gateway 엔드포인트를 통해 Anthropic Messages API 를 사용합니다.

- 프로바이더: `cloudflare-ai-gateway`
- 기본 URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 기본 모델: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API 키: `CLOUDFLARE_AI_GATEWAY_API_KEY` (Gateway 를 통해 요청할 때 사용하는 프로바이더 API 키)

Anthropic 모델의 경우 Anthropic API 키를 사용하십시오.

## 빠른 시작

1. 프로바이더 API 키와 Gateway 세부 정보를 설정합니다:

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

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 인증된 Gateway

Cloudflare 에서 Gateway 인증을 활성화한 경우 `cf-aig-authorization` 헤더를 추가하십시오 (이는 프로바이더 API 키와 별도로 필요합니다).

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

## 환경 참고

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우 `CLOUDFLARE_AI_GATEWAY_API_KEY` 가 해당 프로세스에서 사용 가능하도록 하십시오 (예: `~/.openclaw/.env` 에서 또는 `env.shellEnv` 를 통해).
