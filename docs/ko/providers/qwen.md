---
summary: "OpenClaw 에서 Qwen OAuth (무료 티어) 사용"
read_when:
  - OpenClaw 와 함께 Qwen 을 사용하려는 경우
  - Qwen Coder 에 무료 티어 OAuth 액세스를 사용하려는 경우
title: "Qwen"
---

# Qwen

Qwen 은 Qwen Coder 및 Qwen Vision 모델을 위한 무료 티어 OAuth 흐름을 제공합니다
(하루 2,000 요청, Qwen 레이트 리밋 적용).

## 플러그인 활성화

```bash
openclaw plugins enable qwen-portal-auth
```

활성화한 후 Gateway 를 재시작합니다.

## 인증

```bash
openclaw models auth login --provider qwen-portal --set-default
```

이는 Qwen 디바이스 코드 OAuth 흐름을 실행하고, 프로바이더 항목을
`models.json` 에 기록합니다
(빠른 전환을 위한 `qwen` 별칭 포함).

## 모델 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

모델 전환 방법:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI 로그인 재사용

이미 Qwen Code CLI 로 로그인한 경우, OpenClaw 는 인증 스토어를 로드할 때
`~/.qwen/oauth_creds.json` 에서 자격 증명을 동기화합니다. 여전히
`models.providers.qwen-portal` 항목이 필요합니다
(위의 로그인 명령을 사용하여 생성하십시오).

## 참고

- 토큰은 자동으로 갱신됩니다. 갱신에 실패하거나 액세스가 철회된 경우 로그인 명령을 다시 실행하십시오.
- 기본 베이스 URL: `https://portal.qwen.ai/v1` (Qwen 이 다른 엔드포인트를 제공하는 경우
  `models.providers.qwen-portal.baseUrl` 로 재정의하십시오).
- 프로바이더 전반의 규칙은 [Model providers](/concepts/model-providers) 를 참고하십시오.
