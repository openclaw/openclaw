````markdown
---
summary: "OpenClaw에서 Qwen OAuth (무료 등급) 사용"
read_when:
  - OpenClaw에서 Qwen을 사용하려고 합니다
  - Qwen Coder에 대한 무료 등급의 OAuth 액세스를 원합니다
title: "Qwen"
---

# Qwen

Qwen은 Qwen Coder 및 Qwen Vision 모델에 대한 무료 등급의 OAuth 플로우를 제공합니다
(하루에 2,000 요청, Qwen의 속도 제한에 따라 다름).

## 플러그인 활성화

```bash
openclaw plugins enable qwen-portal-auth
```
````

활성화 후 게이트웨이를 재시작하세요.

## 인증

```bash
openclaw models auth login --provider qwen-portal --set-default
```

이 명령어는 Qwen 디바이스 코드 OAuth 플로우를 실행하고 당신의
`models.json`에 프로바이더 항목을 작성합니다 (`qwen` 빠른 전환을 위한 별칭 포함).

## 모델 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

모델 전환:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI 로그인 재사용

이미 Qwen Code CLI로 로그인한 경우, OpenClaw는 인증 저장소를 로드할 때 `~/.qwen/oauth_creds.json`에서 자격 증명을 동기화합니다. 여전히 `models.providers.qwen-portal` 항목이 필요합니다 (위의 로그인 명령어를 사용하여 생성하세요).

## 참고 사항

- 토큰은 자동으로 갱신됩니다. 갱신이 실패하거나 접근 권한이 해제된 경우 로그인 명령어를 다시 실행하세요.
- 기본 기본 URL: `https://portal.qwen.ai/v1` (Qwen에서 다른 엔드포인트를 제공하는 경우 `models.providers.qwen-portal.baseUrl`로 오버라이드).
- 프로바이더 전반의 규칙에 대해서는 [모델 프로바이더](/concepts/model-providers)를 참조하세요.

```

```
