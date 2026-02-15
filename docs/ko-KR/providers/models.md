---
summary: "Model providers (LLMs) supported by OpenClaw"
read_when:
  - You want to choose a model provider
  - You want quick setup examples for LLM auth + model selection
title: "Model Provider Quickstart"
x-i18n:
  source_hash: 691d2c97ef6b01cceedf59cc5dd238284b24e61048a19c77dce93e07e1bf7690
---

# 모델 제공자

OpenClaw는 많은 LLM 제공업체를 사용할 수 있습니다. 하나를 선택하고 인증한 다음 기본값을 설정하세요.
모델은 `provider/model`입니다.

## 하이라이트: 베니스(베니스 AI)

Venice는 가장 어려운 작업에 Opus를 사용할 수 있는 옵션이 포함된 개인 정보 보호 우선 추론을 위해 권장되는 Venice AI 설정입니다.

- 기본값 : `venice/llama-3.3-70b`
- 전체적으로 최고: `venice/claude-opus-45` (Opus가 여전히 가장 강력함)

[베니스 AI](/providers/venice)를 참조하세요.

## 빠른 시작(2단계)

1. 공급자에게 인증합니다(일반적으로 `openclaw onboard`를 통해).
2. 기본 모델을 설정합니다:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 지원되는 공급자(스타터 세트)

- [OpenAI(API + 코덱스)](/providers/openai)
- [인류학(API + 클로드 코드 CLI)](/providers/anthropic)
- [오픈라우터](/providers/openrouter)
- [Vercel AI 게이트웨이](/providers/vercel-ai-gateway)
- [Cloudflare AI 게이트웨이](/providers/cloudflare-ai-gateway)
- [문샷 AI(키미+키미 코딩)](/providers/moonshot)
- [합성](/providers/synthetic)
- [오픈코드 젠](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM 모델](/providers/glm)
- [미니맥스](/providers/minimax)
- [베니스(베니스 AI)](/providers/venice)
- [아마존 기반암](/providers/bedrock)
- [첸판](/providers/qianfan)

전체 공급자 카탈로그(xAI, Groq, Mistral 등) 및 고급 구성의 경우
[모델 제공자](/concepts/model-providers)를 참조하세요.
