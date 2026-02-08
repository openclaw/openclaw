---
read_when:
    - 모델 제공자를 선택하고 싶습니다.
    - 지원되는 LLM 백엔드에 대한 빠른 개요가 필요합니다.
summary: OpenClaw에서 지원하는 모델 공급자(LLM)
title: 모델 제공자
x-i18n:
    generated_at: "2026-02-08T16:01:28Z"
    model: gtx
    provider: google-translate
    source_hash: af168e89983fab193b94cb1bf3e30bbfb1ec484781693a05335c8966d1141a05
    source_path: providers/index.md
    workflow: 15
---

# 모델 제공자

OpenClaw는 많은 LLM 제공업체를 사용할 수 있습니다. 공급자를 선택하고 인증한 후 설정하세요.
기본 모델 `provider/model`.

채팅 채널 문서(WhatsApp/Telegram/Discord/Slack/Mattermost(플러그인) 등)를 찾고 계십니까? 보다 [채널](/channels).

## 하이라이트: 베니스 (베니스 AI)

Venice는 어려운 작업에 Opus를 사용할 수 있는 옵션이 포함된 개인 정보 보호 우선 추론을 위해 권장되는 Venice AI 설정입니다.

- 기본: `venice/llama-3.3-70b`
- 전반적으로 최고: `venice/claude-opus-45` (Opus는 여전히 가장 강력합니다)

보다 [베니스 AI](/providers/venice).

## 빠른 시작

1. 공급자에게 인증합니다(일반적으로 다음을 통해). `openclaw onboard`).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 제공자 문서

- [OpenAI(API + 코덱스)](/providers/openai)
- [인류학(API + Claude Code CLI)](/providers/anthropic)
- [퀀(OAuth)](/providers/qwen)
- [오픈라우터](/providers/openrouter)
- [Vercel AI 게이트웨이](/providers/vercel-ai-gateway)
- [Cloudflare AI 게이트웨이](/providers/cloudflare-ai-gateway)
- [Moonshot AI (키미 + 키미 코딩)](/providers/moonshot)
- [오픈코드 젠](/providers/opencode)
- [아마존 기반암](/providers/bedrock)
- [Z.AI](/providers/zai)
- [샤오미](/providers/xiaomi)
- [GLM 모델](/providers/glm)
- [미니맥스](/providers/minimax)
- [베니스(Venice AI, 개인 정보 보호 중심)](/providers/venice)
- [올라마(현지모델)](/providers/ollama)
- [첸판](/providers/qianfan)

## 전사 제공업체

- [Deepgram(오디오 전사)](/providers/deepgram)

## 커뮤니티 도구

- [클로드 맥스 API 프록시](/providers/claude-max-api-proxy) - Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용

전체 공급자 카탈로그(xAI, Groq, Mistral 등) 및 고급 구성의 경우
참조 [모델 제공자](/concepts/model-providers).
