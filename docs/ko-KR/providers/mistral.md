---
summary: "OpenClaw 에서 Mistral 모델 및 Voxtral 전사 사용하기"
read_when:
  - OpenClaw 에서 Mistral 모델을 사용하고 싶을 때
  - Mistral API 키 온보딩 및 모델 참조가 필요할 때
title: "Mistral"
x-i18n:
  source_path: docs/providers/mistral.md
---

# Mistral

OpenClaw 는 텍스트/이미지 모델 라우팅 (`mistral/...`) 과 미디어 이해를 통한 Voxtral 오디오 전사 모두에 Mistral 을 지원합니다.
Mistral 은 메모리 임베딩에도 사용할 수 있습니다 (`memorySearch.provider = "mistral"`).

## CLI 설정

```bash
openclaw onboard --auth-choice mistral-api-key
# 또는 비대화형으로
openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## 설정 스니펫 (LLM 프로바이더)

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
}
```

## 설정 스니펫 (Voxtral 을 사용한 오디오 전사)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## 참고 사항

- Mistral 인증은 `MISTRAL_API_KEY` 를 사용합니다.
- 프로바이더 기본 URL 은 `https://api.mistral.ai/v1` 입니다.
- 온보딩 기본 모델은 `mistral/mistral-large-latest` 입니다.
- Mistral 의 미디어 이해 기본 오디오 모델은 `voxtral-mini-latest` 입니다.
- 미디어 전사 경로는 `/v1/audio/transcriptions` 을 사용합니다.
- 메모리 임베딩 경로는 `/v1/embeddings` 를 사용합니다 (기본 모델: `mistral-embed`).
