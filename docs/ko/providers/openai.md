---
read_when:
    - OpenClaw에서 OpenAI 모델을 사용하고 싶습니다.
    - API 키 대신 Codex 구독 인증을 원합니다.
summary: OpenClaw에서 API 키 또는 Codex 구독을 통해 OpenAI 사용
title: 오픈AI
x-i18n:
    generated_at: "2026-02-08T16:00:53Z"
    model: gtx
    provider: google-translate
    source_hash: 6d78698351c3d2f5735d2d9d931834b2e7e22976be89484e23cf08dec6b3f86c
    source_path: providers/openai.md
    workflow: 15
---

# 오픈AI

OpenAI는 GPT 모델용 개발자 API를 제공합니다. 코덱스는 지원합니다 **ChatGPT 로그인** 구독을 위해
접속하거나 **API 키** 사용량 기반 액세스를 위해 로그인하세요. Codex 클라우드에는 ChatGPT 로그인이 필요합니다.

## 옵션 A: OpenAI API 키(OpenAI 플랫폼)

**가장 적합한 대상:** 직접 API 액세스 및 사용량 기반 청구.
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

**가장 적합한 대상:** API 키 대신 ChatGPT/Codex 구독 액세스를 사용합니다.
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

- 모델 심판은 항상 사용 `provider/model` (보다 [/개념/모델](/concepts/models)).
- 인증 세부정보 + 재사용 규칙은 다음과 같습니다. [/개념/oauth](/concepts/oauth).
