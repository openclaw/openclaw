---
read_when:
    - OpenClaw와 함께 Qwen을 사용하고 싶습니다.
    - Qwen Coder에 대한 무료 OAuth 액세스를 원합니다.
summary: OpenClaw에서 Qwen OAuth(무료 등급) 사용
title: 퀀
x-i18n:
    generated_at: "2026-02-08T16:07:19Z"
    model: gtx
    provider: google-translate
    source_hash: 88b88e224e2fecbb1ca26e24fbccdbe25609be40b38335d0451343a5da53fdd4
    source_path: providers/qwen.md
    workflow: 15
---

# 퀀

Qwen은 Qwen Coder 및 Qwen Vision 모델에 대한 무료 계층 OAuth 흐름을 제공합니다.
(1일 요청 2,000건, Qwen 비율 제한 적용)

## 플러그인 활성화

```bash
openclaw plugins enable qwen-portal-auth
```

활성화한 후 게이트웨이를 다시 시작하십시오.

## 인증하다

```bash
openclaw models auth login --provider qwen-portal --set-default
```

그러면 Qwen 장치 코드 OAuth 흐름이 실행되고 공급자 항목이
`models.json` (그리고 `qwen` 빠른 전환을 위한 별칭).

## 모델 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

다음을 사용하여 모델을 전환하세요.

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI 로그인 재사용

이미 Qwen Code CLI로 로그인한 경우 OpenClaw는 자격 증명을 동기화합니다.
에서 `~/.qwen/oauth_creds.json` 인증 스토어를 로드할 때. 당신은 여전히
`models.providers.qwen-portal` 항목(위의 로그인 명령을 사용하여 생성).

## 메모

- 토큰 자동 새로고침 새로 고침이 실패하거나 액세스가 취소되면 로그인 명령을 다시 실행하십시오.
- 기본 기본 URL: `https://portal.qwen.ai/v1` (다음으로 재정의
  `models.providers.qwen-portal.baseUrl` Qwen이 다른 엔드포인트를 제공하는 경우)
- 보다 [모델 제공자](/concepts/model-providers) 공급자 전체 규칙의 경우.
