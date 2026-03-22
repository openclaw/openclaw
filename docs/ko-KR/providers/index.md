---
summary: "OpenClaw 에서 지원하는 모델 프로바이더 (LLM)"
read_when:
  - 모델 프로바이더를 선택하고 싶을 때
  - 지원되는 LLM 백엔드에 대한 간략한 개요가 필요할 때
title: "프로바이더 디렉토리"
x-i18n:
  source_path: docs/providers/index.md
---

# 모델 프로바이더

OpenClaw 는 다양한 LLM 프로바이더를 사용할 수 있습니다. 프로바이더를 선택하고, 인증한 다음, 기본 모델을 `provider/model` 형식으로 설정하세요.

채팅 채널 문서 (WhatsApp/Telegram/Discord/Slack/Mattermost (플러그인)/기타) 를 찾고 계신가요? [Channels](/channels) 를 참조하세요.

## 빠른 시작

1. 프로바이더에 인증합니다 (보통 `openclaw onboard` 를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프로바이더 문서

- [Amazon Bedrock](/providers/bedrock)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [GLM models](/providers/glm)
- [Google (Gemini)](/providers/google)
- [Groq (LPU inference)](/providers/groq)
- [Hugging Face (Inference)](/providers/huggingface)
- [Kilocode](/providers/kilocode)
- [LiteLLM (unified gateway)](/providers/litellm)
- [MiniMax](/providers/minimax)
- [Mistral](/providers/mistral)
- [Model Studio (Alibaba Cloud)](/providers/modelstudio)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [NVIDIA](/providers/nvidia)
- [Ollama (cloud + local models)](/providers/ollama)
- [OpenAI (API + Codex)](/providers/openai)
- [OpenCode (Zen + Go)](/providers/opencode)
- [OpenRouter](/providers/openrouter)
- [Perplexity (web search)](/providers/perplexity-provider)
- [Qianfan](/providers/qianfan)
- [Qwen (OAuth)](/providers/qwen)
- [SGLang (local models)](/providers/sglang)
- [Together AI](/providers/together)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Venice (Venice AI, privacy-focused)](/providers/venice)
- [vLLM (local models)](/providers/vllm)
- [Volcengine (Doubao)](/providers/volcengine)
- [xAI](/providers/xai)
- [Xiaomi](/providers/xiaomi)
- [Z.AI](/providers/zai)

## 전사 프로바이더

- [Deepgram (오디오 전사)](/providers/deepgram)

## 커뮤니티 도구

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude 구독 자격 증명을 위한 커뮤니티 프록시 (사용 전 Anthropic 정책/약관을 확인하세요)

전체 프로바이더 카탈로그 (xAI, Groq, Mistral 등) 및 고급 설정은
[Model providers](/concepts/model-providers) 를 참조하세요.
