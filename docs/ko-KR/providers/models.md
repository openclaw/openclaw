---
summary: "OpenClaw 에서 지원하는 모델 프로바이더 (LLM)"
read_when:
  - 모델 프로바이더를 선택하고 싶을 때
  - LLM 인증 및 모델 선택에 대한 빠른 설정 예제가 필요할 때
title: "모델 프로바이더 빠른 시작"
x-i18n:
  source_path: docs/providers/models.md
---

# 모델 프로바이더

OpenClaw 는 다양한 LLM 프로바이더를 사용할 수 있습니다. 하나를 선택하고, 인증한 다음, 기본 모델을 `provider/model` 형식으로 설정하세요.

## 빠른 시작 (두 단계)

1. 프로바이더에 인증합니다 (보통 `openclaw onboard` 를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 지원되는 프로바이더 (기본 세트)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Mistral](/providers/mistral)
- [Synthetic](/providers/synthetic)
- [OpenCode (Zen + Go)](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)
- [xAI](/providers/xai)

전체 프로바이더 카탈로그 (xAI, Groq, Mistral 등) 및 고급 설정은
[Model providers](/concepts/model-providers) 를 참조하세요.
