---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
title: "OpenAI"
x-i18n:
  source_hash: 6d78698351c3d2f5735d2d9d931834b2e7e22976be89484e23cf08dec6b3f86c
---

# 오픈AI

OpenAI는 GPT 모델용 개발자 API를 제공합니다. Codex는 구독을 위해 **ChatGPT 로그인**을 지원합니다.
사용량 기반 액세스를 위한 액세스 또는 **API 키** 로그인. Codex 클라우드에는 ChatGPT 로그인이 필요합니다.

## 옵션 A: OpenAI API 키(OpenAI 플랫폼)

**최적의 용도:** 직접 API 액세스 및 사용량 기반 청구.
OpenAI 대시보드에서 API 키를 받으세요.

### CLI 설정

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 구성 스니펫

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## 옵션 B: OpenAI 코드(Codex) 구독

**최적의 용도:** API 키 대신 ChatGPT/Codex 구독 액세스를 사용합니다.
Codex 클라우드에는 ChatGPT 로그인이 필요하지만 Codex CLI는 ChatGPT 또는 API 키 로그인을 지원합니다.

### CLI 설정(Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 구성 조각(Codex 구독)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 메모

- 모델 참조는 항상 `provider/model`를 사용합니다([/concepts/models](/concepts/models) 참조).
- 인증 세부정보 + 재사용 규칙은 [/concepts/oauth](/concepts/oauth)에 있습니다.
