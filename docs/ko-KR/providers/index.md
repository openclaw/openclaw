---
summary: "Model providers (LLMs) supported by OpenClaw"
read_when:
  - You want to choose a model provider
  - You need a quick overview of supported LLM backends
title: "Model Providers"
x-i18n:
  source_hash: dd7b1a1b76dc44cf17ceb2e8883ef56f07b4b8c4c227c3182d37e073215facab
---

# 모델 제공자

OpenClaw는 많은 LLM 제공업체를 사용할 수 있습니다. 공급자를 선택하고 인증한 후 설정하세요.
기본 모델은 `provider/model`입니다.

채팅 채널 문서(WhatsApp/Telegram/Discord/Slack/Mattermost(플러그인) 등)를 찾고 계십니까? [채널](/channels)을 참조하세요.

## 하이라이트: 베니스(베니스 AI)

Venice는 어려운 작업에 Opus를 사용할 수 있는 옵션이 포함된 개인 정보 보호 우선 추론을 위해 권장되는 Venice AI 설정입니다.

- 기본값 : `venice/llama-3.3-70b`
- 전체적으로 최고: `venice/claude-opus-45` (Opus가 여전히 가장 강력함)

[베니스 AI](/providers/venice)를 참조하세요.

## 빠른 시작

1. 공급자에게 인증합니다(일반적으로 `openclaw onboard`를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 제공자 문서

- [OpenAI(API + 코덱스)](/providers/openai)
- [인류(API + 클로드 코드 CLI)](/providers/anthropic)
- [Qwen(OAuth)](/providers/qwen)
- [오픈라우터](/providers/openrouter)
- [LiteLLM(통합 게이트웨이)](/providers/litellm)
- [Vercel AI 게이트웨이](/providers/vercel-ai-gateway)
- [함께하는 AI](/providers/together)
- [Cloudflare AI 게이트웨이](/providers/cloudflare-ai-gateway)
- [문샷 AI(키미+키미 코딩)](/providers/moonshot)
- [오픈코드 젠](/providers/opencode)
- [아마존 기반암](/providers/bedrock)
- [Z.AI](/providers/zai)
- [샤오미](/providers/xiaomi)
- [GLM 모델](/providers/glm)
- [미니맥스](/providers/minimax)
- [베니스(베니스 AI, 개인 정보 보호 중심)](/providers/venice)
- [올라마(현지 모델)](/providers/ollama)
- [첸판](/providers/qianfan)

## 전사 제공업체

- [딥그램(음성 전사)](/providers/deepgram)

## 커뮤니티 도구

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용

전체 공급자 카탈로그(xAI, Groq, Mistral 등) 및 고급 구성의 경우
[모델 제공자](/concepts/model-providers)를 참조하세요.
