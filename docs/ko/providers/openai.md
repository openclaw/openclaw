---
summary: "OpenClaw 에서 API 키 또는 Codex 구독을 통해 OpenAI 를 사용하는 방법"
read_when:
  - OpenClaw 에서 OpenAI 모델을 사용하려는 경우
  - API 키 대신 Codex 구독 인증을 사용하려는 경우
title: "OpenAI"
---

# OpenAI

OpenAI 는 GPT 모델을 위한 개발자 API 를 제공합니다. Codex 는 구독 기반 액세스를 위한 **ChatGPT 로그인** 또는 사용량 기반 액세스를 위한 **API 키** 로그인을 지원합니다. Codex cloud 는 ChatGPT 로그인이 필요합니다.

## 옵션 A: OpenAI API 키 (OpenAI Platform)

**적합한 경우:** 직접적인 API 액세스와 사용량 기반 과금.
OpenAI 대시보드에서 API 키를 받으십시오.

### CLI 설정

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 설정 스니펫

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## 옵션 B: OpenAI Code (Codex) 구독

**적합한 경우:** API 키 대신 ChatGPT/Codex 구독 액세스를 사용하는 경우.
Codex cloud 는 ChatGPT 로그인이 필요하며, Codex CLI 는 ChatGPT 또는 API 키 로그인을 지원합니다.

### CLI 설정 (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 설정 스니펫 (Codex 구독)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 참고 사항

- 모델 참조는 항상 `provider/model` 를 사용합니다 (자세한 내용은 [/concepts/models](/concepts/models) 를 참고하십시오).
- 인증 세부 정보와 재사용 규칙은 [/concepts/oauth](/concepts/oauth) 에 있습니다.
