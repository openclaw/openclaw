---
summary: "OpenClaw에서 지원하는 모델 프로바이더 (LLMs)"
read_when:
  - 모델 프로바이더를 선택하고 싶은 경우
  - LLM 인증 + 모델 선택에 대한 빠른 설정 예제가 필요한 경우
title: "모델 프로바이더 빠른 시작 가이드"
---

# 모델 프로바이더

OpenClaw는 다양한 LLM 프로바이더를 사용할 수 있습니다. 하나를 선택하고, 인증한 다음, 기본 모델을 `provider/model`로 설정하세요.

## 하이라이트: Venice (Venice AI)

Venice는 개인 정보 보호를 우선시하는 추론을 위한 추천 Venice AI 설정이며, 가장 어려운 작업에 대해 Opus를 사용할 수 있는 옵션이 있습니다.

- 기본값: `venice/llama-3.3-70b`
- 가장 우수: `venice/claude-opus-45` (Opus가 여전히 가장 강력함)

자세한 내용은 [Venice AI](/providers/venice)를 참조하세요.

## 빠른 시작 (두 단계)

1. 프로바이더에 인증하기 (보통 `openclaw onboard`를 통해 실행).
2. 기본 모델 설정하기:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 지원되는 프로바이더 (초기 세트)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI 게이트웨이](/providers/vercel-ai-gateway)
- [Cloudflare AI 게이트웨이](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM 모델](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

전체 프로바이더 목록 (xAI, Groq, Mistral 등) 및 고급 구성에 대해서는 [모델 프로바이더](/concepts/model-providers)를 참조하세요.
