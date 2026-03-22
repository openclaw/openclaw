---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw 에서 Vercel AI Gateway 를 사용하고 싶을 때
  - API 키 환경 변수 또는 CLI 인증 선택이 필요할 때
x-i18n:
  source_path: docs/providers/vercel-ai-gateway.md
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 는 단일 엔드포인트를 통해 수백 개의 모델에 액세스할 수 있는 통합 API 를 제공합니다.

- 프로바이더: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages 호환
- OpenClaw 는 Gateway `/v1/models` 카탈로그를 자동 검색하므로, `/models vercel-ai-gateway` 에
  `vercel-ai-gateway/openai/gpt-5.4` 와 같은 현재 모델 참조가 포함됩니다.

## 빠른 시작

1. API 키를 설정합니다 (권장: Gateway 용으로 저장):

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

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `AI_GATEWAY_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).

## 모델 ID 단축형

OpenClaw 는 Vercel Claude 단축형 모델 참조를 수락하고 런타임에 정규화합니다:

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
