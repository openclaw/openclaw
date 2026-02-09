---
summary: "OpenClaw 에서 지원하는 모델 프로바이더 (LLM)"
read_when:
  - 모델 프로바이더를 선택하려는 경우
  - LLM 인증 + 모델 선택을 위한 빠른 설정 예제가 필요한 경우
title: "모델 프로바이더 빠른 시작"
---

# 모델 프로바이더

OpenClaw 는 다양한 LLM 프로바이더를 사용할 수 있습니다. 하나를 선택하고 인증한 다음,
기본 모델을 `provider/model` 로 설정합니다.

## 하이라이트: Venice (Venice AI)

Venice 는 프라이버시 우선 추론을 위한 권장 Venice AI 설정이며, 가장 어려운 작업에는 Opus 를 사용할 수 있는 옵션을 제공합니다.

- 기본값: `venice/llama-3.3-70b`
- 전반적으로 최고: `venice/claude-opus-45` (Opus 가 여전히 가장 강력합니다)

[Venice AI](/providers/venice)를 참고하십시오.

## 빠른 시작 (두 단계)

1. 프로바이더로 인증합니다 (일반적으로 `openclaw onboard` 를 사용).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 지원되는 프로바이더 (스타터 세트)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

전체 제공업체 카탈로그(xAI, Groq, Mistral 등)는 전체 프로바이더 카탈로그 (xAI, Groq, Mistral 등)와 고급 구성에 대해서는
[Model providers](/concepts/model-providers)를 참고하십시오.
