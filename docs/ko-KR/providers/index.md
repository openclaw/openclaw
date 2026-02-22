---
summary: "OpenClaw에서 지원하는 모델 프로바이더 (LLMs)"
read_when:
  - 모델 프로바이더를 선택하고 싶을 때
  - 지원되는 LLM 백엔드의 빠른 개요가 필요할 때
title: "모델 프로바이더"
---

# Model Providers

OpenClaw는 많은 LLM 프로바이더를 사용할 수 있습니다. 프로바이더를 선택하고 인증한 뒤, 기본 모델을 `provider/model`로 설정하세요.

채팅 채널 문서 (WhatsApp/Telegram/Discord/Slack/Mattermost (플러그인)/기타)를 찾나요? [채널](/ko-KR/channels)을 참조하세요.

## Highlight: Venice (Venice AI)

Venice는 개인 정보 우선 추론을 위한 권장 Venice AI 설정이며, 어려운 작업에는 Opus를 사용할 수 있는 옵션이 있습니다.

- 기본: `venice/llama-3.3-70b`
- 전반적으로 최고: `venice/claude-opus-45` (Opus가 여전히 가장 강력함)

[Venice AI](/ko-KR/providers/venice)를 참조하세요.

## 빠른 시작

1. 프로바이더에 인증하십시오 (보통 `openclaw onboard`를 통해).
2. 기본 모델을 설정하세요:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프로바이더 문서

- [OpenAI (API + Codex)](/ko-KR/providers/openai)
- [Anthropic (API + Claude Code CLI)](/ko-KR/providers/anthropic)
- [Qwen (OAuth)](/ko-KR/providers/qwen)
- [OpenRouter](/ko-KR/providers/openrouter)
- [LiteLLM (통합 게이트웨이)](/ko-KR/providers/litellm)
- [Vercel AI 게이트웨이](/ko-KR/providers/vercel-ai-gateway)
- [Together AI](/ko-KR/providers/together)
- [Cloudflare AI 게이트웨이](/ko-KR/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/ko-KR/providers/moonshot)
- [OpenCode Zen](/ko-KR/providers/opencode)
- [Amazon Bedrock](/ko-KR/providers/bedrock)
- [Z.AI](/ko-KR/providers/zai)
- [Xiaomi](/ko-KR/providers/xiaomi)
- [GLM 모델](/ko-KR/providers/glm)
- [MiniMax](/ko-KR/providers/minimax)
- [Venice (Venice AI, 프라이버시 중심)](/ko-KR/providers/venice)
- [Hugging Face (Inference)](/ko-KR/providers/huggingface)
- [Ollama (로컬 모델)](/ko-KR/providers/ollama)
- [vLLM (로컬 모델)](/ko-KR/providers/vllm)
- [Qianfan](/ko-KR/providers/qianfan)
- [NVIDIA](/ko-KR/providers/nvidia)

## 전사 프로바이더

- [Deepgram (음성 전사)](/ko-KR/providers/deepgram)

## 커뮤니티 도구

- [Claude Max API 프록시](/ko-KR/providers/claude-max-api-proxy) - OpenAI 호환 API 엔드포인트로 Claude Max/Pro 구독을 사용하세요

전체 프로바이더 카탈로그(xAI, Groq, Mistral 등) 및 고급 설정은 [모델 프로바이더](/ko-KR/concepts/model-providers)를 참조하세요.