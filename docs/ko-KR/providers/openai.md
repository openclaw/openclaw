---
summary: "OpenAI를 OpenClaw에서 API 키 또는 Codex 구독을 통해 사용"
read_when:
  - OpenClaw에서 OpenAI 모델을 사용하고 싶은 경우
  - API 키 대신 Codex 구독 인증을 원할 때
title: "OpenAI"
---

# OpenAI

OpenAI는 GPT 모델을 위한 개발자 API를 제공합니다. Codex는 구독 접근을 위한 **ChatGPT 로그인** 또는 사용량 기반 접근을 위한 **API 키** 로그인을 지원합니다. Codex 클라우드는 ChatGPT 로그인이 필요합니다.

## Option A: OpenAI API key (OpenAI Platform)

**적합한 경우:** 직접 API 접근 및 사용량 기반 청구.
OpenAI 대시보드에서 API 키를 받으세요.

### CLI 설정

```bash
openclaw onboard --auth-choice openai-api-key
# 또는 비대화형으로
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 설정 스니펫

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Option B: OpenAI Code (Codex) subscription

**적합한 경우:** API 키 대신 ChatGPT/Codex 구독 접근을 사용하는 경우.
Codex 클라우드는 ChatGPT 로그인을 요구하며, Codex CLI는 ChatGPT 또는 API 키 로그인을 지원합니다.

### CLI 설정 (Codex OAuth)

```bash
# 마법사에서 Codex OAuth 실행
openclaw onboard --auth-choice openai-codex

# 또는 직접 OAuth 실행
openclaw models auth login --provider openai-codex
```

### 설정 스니펫 (Codex 구독)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notes

- 모델 참조는 항상 `provider/model` 형식을 사용합니다 (자세한 내용은 [/concepts/models](/ko-KR/concepts/models)를 참조).
- 인증 세부 사항 및 재사용 규칙은 [/concepts/oauth](/ko-KR/concepts/oauth)에 있습니다.