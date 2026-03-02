---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw에서 Vercel AI Gateway를 사용하고 싶을 때
  - API 키 환경 변수 또는 CLI 인증 선택이 필요할 때
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/vercel-ai-gateway.md"
  workflow: 15
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway)는 단일 엔드포인트를 통해 수백 개의 모델에 액세스할 수 있는 통합 API를 제공합니다.

- 제공자: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- API: Anthropic 메시지 호환

## 빠른 시작

1. API 키를 설정합니다 (권장: Gateway에 저장):

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

## 환경 참고

Gateway가 데몬으로 실행되는 경우 (launchd/systemd) `AI_GATEWAY_API_KEY`를 해당 프로세스에서 사용할 수 있는지 확인합니다 (예: `~/.openclaw/.env` 또는 `env.shellEnv`를 통해).

## 모델 ID 속기

OpenClaw는 Vercel Claude 속기 모델 참조를 허용하고 런타임에 정규화합니다:

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
