---
summary: "OpenClaw에서 Qwen OAuth (무료 계층)을 사용합니다"
read_when:
  - OpenClaw에서 Qwen을 사용하고 싶을 때
  - Qwen Coder에 무료 계층 OAuth 액세스를 원할 때
title: "Qwen"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/qwen.md"
  workflow: 15
---

# Qwen

Qwen은 Qwen Coder 및 Qwen Vision 모델에 대한 무료 계층 OAuth 흐름을 제공합니다
(2,000 요청/일, Qwen 속도 제한 적용).

## 플러그인 활성화

```bash
openclaw plugins enable qwen-portal-auth
```

활성화 후 Gateway를 다시 시작합니다.

## 인증

```bash
openclaw models auth login --provider qwen-portal --set-default
```

이는 Qwen 디바이스 코드 OAuth 흐름을 실행하고 `models.json` (및 빠른 전환을 위한 `qwen` 별칭)에 제공자 항목을 씁니다.

## 모델 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

다음을 사용하여 모델을 전환합니다:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI 로그인 재사용

Qwen Code CLI로 이미 로그인한 경우 OpenClaw는 게이트웨이가 인증 저장소를 로드할 때 `~/.qwen/oauth_creds.json`에서 자격증명을 동기화합니다. 여전히 `models.providers.qwen-portal` 항목이 필요합니다 (위의 로그인 명령을 사용하여 하나를 생성합니다).

## 참고

- 토큰은 자동 새로 고침됩니다. 새로 고침이 실패하거나 액세스가 취소된 경우 로그인 명령을 다시 실행합니다.
- 기본 기본 URL: `https://portal.qwen.ai/v1` (Qwen이 다른 엔드포인트를 제공하는 경우 `models.providers.qwen-portal.baseUrl`로 재정의합니다).
- 제공자 전체 규칙은 [모델 제공자](/concepts/model-providers)를 참조하세요.
