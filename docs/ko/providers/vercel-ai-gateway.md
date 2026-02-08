---
read_when:
    - OpenClaw와 함께 Vercel AI Gateway를 사용하고 싶습니다.
    - API 키 env var 또는 CLI 인증 선택이 필요합니다.
summary: Vercel AI Gateway 설정(인증 + 모델 선택)
title: Vercel AI 게이트웨이
x-i18n:
    generated_at: "2026-02-08T16:02:33Z"
    model: gtx
    provider: google-translate
    source_hash: 2bf1687c1152c6e1afe1092631e0fc184837d35b219044002241395158e4b8f6
    source_path: providers/vercel-ai-gateway.md
    workflow: 15
---

# Vercel AI 게이트웨이

그만큼 [Vercel AI 게이트웨이](https://vercel.com/ai-gateway) 단일 엔드포인트를 통해 수백 개의 모델에 액세스할 수 있는 통합 API를 제공합니다.

- 공급자: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- API: 인류학적 메시지 호환

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

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우 다음을 확인하세요. `AI_GATEWAY_API_KEY`
해당 프로세스에서 사용할 수 있습니다(예: `~/.openclaw/.env` 또는 통해
`env.shellEnv`).
