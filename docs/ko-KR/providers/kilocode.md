---
title: "Kilo Gateway"
summary: "OpenClaw 에서 Kilo Gateway 의 통합 API 를 사용하여 다양한 모델에 액세스하기"
read_when:
  - 다양한 LLM 에 대한 단일 API 키를 원할 때
  - OpenClaw 에서 Kilo Gateway 를 통해 모델을 실행하고 싶을 때
x-i18n:
  source_path: docs/providers/kilocode.md
---

# Kilo Gateway

Kilo Gateway 는 단일 엔드포인트와 API 키 뒤에서 많은 모델로 요청을 라우팅하는 **통합 API** 를 제공합니다. OpenAI 호환이므로 대부분의 OpenAI SDK 가 기본 URL 만 변경하면 작동합니다.

## API 키 받기

1. [app.kilo.ai](https://app.kilo.ai) 로 이동합니다
2. 로그인하거나 계정을 생성합니다
3. API Keys 로 이동하여 새 키를 생성합니다

## CLI 설정

```bash
openclaw onboard --kilocode-api-key <key>
```

또는 환경 변수를 설정합니다:

```bash
export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
```

## 설정 스니펫

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

## 기본 모델

기본 모델은 `kilocode/kilo/auto` 이며, 작업에 따라 최적의 기본 모델을 자동으로 선택하는 스마트 라우팅 모델입니다:

- 계획, 디버깅 및 오케스트레이션 작업은 Claude Opus 로 라우팅됩니다
- 코드 작성 및 탐색 작업은 Claude Sonnet 으로 라우팅됩니다

## 사용 가능한 모델

OpenClaw 는 시작 시 Kilo Gateway 에서 사용 가능한 모델을 동적으로 검색합니다. `/models kilocode` 를 사용하여 계정에서 사용 가능한 전체 모델 목록을 확인하세요.

게이트웨이에서 사용 가능한 모든 모델은 `kilocode/` 접두사로 사용할 수 있습니다:

```
kilocode/kilo/auto              (기본 - 스마트 라우팅)
kilocode/anthropic/claude-sonnet-4
kilocode/openai/gpt-5.2
kilocode/google/gemini-3-pro-preview
...그 외 다수
```

## 참고 사항

- 모델 참조는 `kilocode/<model-id>` 형식입니다 (예: `kilocode/anthropic/claude-sonnet-4`).
- 기본 모델: `kilocode/kilo/auto`
- 기본 URL: `https://api.kilo.ai/api/gateway/`
- 추가 모델/프로바이더 옵션은 [/concepts/model-providers](/concepts/model-providers) 를 참조하세요.
- Kilo Gateway 는 내부적으로 API 키와 함께 Bearer 토큰을 사용합니다.
