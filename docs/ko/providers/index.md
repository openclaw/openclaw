---
summary: "OpenClaw 에서 지원하는 모델 프로바이더 (LLM)"
read_when:
  - 모델 프로바이더를 선택하려는 경우
  - 지원되는 LLM 백엔드의 빠른 개요가 필요한 경우
title: "모델 프로바이더"
---

# 모델 프로바이더

OpenClaw 는 여러 LLM 프로바이더를 사용할 수 있습니다. 프로바이더를 선택하고 인증한 다음,
기본 모델을 `provider/model` 로 설정합니다.

채팅 채널 문서 (WhatsApp/Telegram/Discord/Slack/Mattermost (플러그인)/등)를 찾고 계신가요? [Channels](/channels)를 참고하십시오.

## 하이라이트: Venice (Venice AI)

Venice 는 개인정보 보호를 우선하는 추론을 위해 권장되는 Venice AI 설정이며, 어려운 작업에는 Opus 를 사용할 수 있는 옵션을 제공합니다.

- 기본값: `venice/llama-3.3-70b`
- 전반적으로 최고: `venice/claude-opus-45` (Opus 가 여전히 가장 강력함)

자세한 내용은 [Venice AI](/providers/venice)를 참고하십시오.

## 빠른 시작

1. 프로바이더로 인증합니다 (보통 `openclaw onboard` 를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프로바이더 문서

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, 개인정보 보호 중심)](/providers/venice)
- [Ollama (로컬 모델)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## 전사 제공업체

- [Deepgram (오디오 전사)](/providers/deepgram)

## 커뮤니티 도구

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용합니다

전체 제공업체 카탈로그(xAI, Groq, Mistral 등)는 전체 프로바이더 카탈로그 (xAI, Groq, Mistral 등) 및 고급 구성은
[Model providers](/concepts/model-providers)를 참고하십시오.
