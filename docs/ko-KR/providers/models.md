---
summary: "OpenClaw에서 지원하는 모델 제공업체(LLM)"
read_when:
  - 모델 제공업체를 선택하고 싶을 때
  - LLM 인증 및 모델 선택에 대한 빠른 설정 예제를 원할 때
title: "모델 제공업체 빠른 시작"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/models.md"
  workflow: 15
---

# 모델 제공업체

OpenClaw는 많은 LLM 제공업체를 사용할 수 있습니다. 하나를 선택한 후 인증한 다음 기본 모델을 `provider/model`로 설정합니다.

## 하이라이트: Venice (Venice AI)

Venice는 가장 어려운 작업을 위해 개인정보 보호 우선 추론과 Opus를 사용할 수 있는 옵션이 있는 권장되는 Venice AI 설정입니다.

- 기본값: `venice/llama-3.3-70b`
- 최고 품질: `venice/claude-opus-45` (Opus는 여전히 가장 강력합니다)

[Venice AI](/providers/venice)를 참조하세요.

## 빠른 시작 (두 단계)

1. 제공업체로 인증합니다(일반적으로 `openclaw onboard`를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 지원되는 제공업체 (시작 세트)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Mistral](/providers/mistral)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM 모델](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

전체 제공업체 카탈로그(xAI, Groq, Mistral 등) 및 고급 구성은 [모델 제공업체](/concepts/model-providers)를 참조하세요.
