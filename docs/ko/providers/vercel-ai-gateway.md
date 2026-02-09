---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw 와 함께 Vercel AI Gateway 를 사용하려는 경우
  - API 키 환경 변수 또는 CLI 인증 선택이 필요한 경우
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway)는 단일 엔드포인트를 통해 수백 개의 모델에 접근할 수 있는 통합 API 를 제공합니다.

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages 호환

## 빠른 시작

1. API 키를 설정합니다 (권장: Gateway 에 저장):

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

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, `AI_GATEWAY_API_KEY` 가
해당 프로세스에서 사용 가능해야 합니다 (예: `~/.openclaw/.env` 에서 또는
`env.shellEnv` 를 통해).
