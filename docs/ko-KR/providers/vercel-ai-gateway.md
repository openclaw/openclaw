---
title: "Vercel AI 게이트웨이"
summary: "Vercel AI 게이트웨이 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw와 Vercel AI 게이트웨이를 사용하고 싶을 때
  - API 키 환경 변수 또는 CLI 인증 선택이 필요할 때
---

# Vercel AI 게이트웨이

[Vercel AI 게이트웨이](https://vercel.com/ai-gateway)는 단일 엔드포인트를 통해 수백 개의 모델에 접근할 수 있는 통합 API를 제공합니다.

- 프로바이더: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages 호환

## 빠른 시작

1. API 키를 설정합니다 (권장: 이를 게이트웨이에 저장하세요):

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

## 환경 주의사항

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우, `AI_GATEWAY_API_KEY`가 해당 프로세스에 제공되는지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv`를 통해).
