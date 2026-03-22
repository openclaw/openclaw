---
title: "Google (Gemini)"
summary: "Google Gemini 설정 (API 키 + OAuth, 이미지 생성, 미디어 이해, 웹 검색)"
read_when:
  - OpenClaw 에서 Google Gemini 모델을 사용하고 싶을 때
  - API 키 또는 OAuth 인증 플로우가 필요할 때
x-i18n:
  source_path: docs/providers/google.md
---

# Google (Gemini)

Google 플러그인은 Google AI Studio 를 통해 Gemini 모델에 대한 액세스와 함께 이미지 생성, 미디어 이해 (이미지/오디오/비디오), Gemini Grounding 을 통한 웹 검색을 제공합니다.

- 프로바이더: `google`
- 인증: `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY`
- API: Google Gemini API
- 대체 프로바이더: `google-gemini-cli` (OAuth)

## 빠른 시작

1. API 키를 설정합니다:

```bash
openclaw onboard --auth-choice google-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "google/gemini-3.1-pro-preview" },
    },
  },
}
```

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice google-api-key \
  --gemini-api-key "$GEMINI_API_KEY"
```

## OAuth (Gemini CLI)

대체 프로바이더 `google-gemini-cli` 는 API 키 대신 PKCE OAuth 를 사용합니다. 이것은 비공식 통합이며 일부 사용자가 계정 제한을 보고하고 있습니다. 본인 책임 하에 사용하세요.

환경 변수:

- `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
- `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

(`GEMINI_CLI_*` 변형도 사용 가능합니다.)

## 기능

| 기능                | 지원             |
| ------------------- | ---------------- |
| 채팅 완성           | 예               |
| 이미지 생성         | 예               |
| 이미지 이해         | 예               |
| 오디오 전사         | 예               |
| 비디오 이해         | 예               |
| 웹 검색 (Grounding) | 예               |
| Thinking/추론       | 예 (Gemini 3.1+) |

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `GEMINI_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).
