---
summary: "OpenClaw에서 지원하는 모델 제공업체(LLM)"
read_when:
  - 모델 제공업체를 선택하고 싶을 때
  - 지원되는 LLM 백엔드의 빠른 개요가 필요할 때
title: "모델 제공업체"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/index.md"
  workflow: 15
---

# 모델 제공업체

OpenClaw는 많은 LLM 제공업체를 사용할 수 있습니다. 제공업체를 선택한 후 인증한 다음 기본 모델을 `provider/model`로 설정합니다.

채팅 채널 문서(WhatsApp/Telegram/Discord/Slack/Mattermost (플러그인) 등)를 찾고 있으신가요? [채널](/channels)을 참조하세요.

## 하이라이트: Venice (Venice AI)

Venice는 개인정보 보호 우선 추론과 어려운 작업을 위해 Opus를 사용할 수 있는 옵션이 있는 권장되는 Venice AI 설정입니다.

- 기본값: `venice/llama-3.3-70b`
- 최고 품질: `venice/claude-opus-45` (Opus는 여전히 가장 강력합니다)

[Venice AI](/providers/venice)를 참조하세요.

## 빠른 시작

1. 제공업체로 인증합니다(일반적으로 `openclaw onboard`를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 제공업체 문서

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [LiteLLM (통합 게이트웨이)](/providers/litellm)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Together AI](/providers/together)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Mistral](/providers/mistral)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM 모델](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, 개인정보 보호 중심)](/providers/venice)
- [Hugging Face (Inference)](/providers/huggingface)
- [Ollama (로컬 모델)](/providers/ollama)
- [vLLM (로컬 모델)](/providers/vllm)
- [Qianfan](/providers/qianfan)
- [NVIDIA](/providers/nvidia)

## 전사 제공업체

- [Deepgram (오디오 전사)](/providers/deepgram)

## 커뮤니티 도구

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용

전체 제공업체 카탈로그(xAI, Groq, Mistral 등) 및 고급 구성은 [모델 제공업체](/concepts/model-providers)를 참조하세요.
