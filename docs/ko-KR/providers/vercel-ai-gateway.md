---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Vercel AI Gateway with OpenClaw
  - You need the API key env var or CLI auth choice
x-i18n:
  source_hash: 2bf1687c1152c6e1afe1092631e0fc184837d35b219044002241395158e4b8f6
---

# Vercel AI 게이트웨이

[Vercel AI Gateway](https://vercel.com/ai-gateway)는 단일 엔드포인트를 통해 수백 가지 모델에 액세스할 수 있는 통합 API를 제공합니다.

- 제공자: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- API: Anthropic 메시지 호환

## 빠른 시작

1. API 키를 설정합니다(권장: 게이트웨이용으로 저장).

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 비대화형 예시

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 환경 참고 사항

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우 `AI_GATEWAY_API_KEY`를 확인하세요.
해당 프로세스에서 사용할 수 있습니다(예: `~/.openclaw/.env` 또는 다음을 통해).
`env.shellEnv`).
