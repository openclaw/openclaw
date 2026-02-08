---
read_when:
    - 어떤 환경 변수가 어떤 순서로 로드되는지 알아야 합니다.
    - 게이트웨이에서 누락된 API 키를 디버깅하고 있습니다.
    - 공급자 인증 또는 배포 환경을 문서화하고 있습니다.
summary: OpenClaw가 환경 변수와 우선 순위를 로드하는 위치
title: 환경 변수
x-i18n:
    generated_at: "2026-02-08T16:05:44Z"
    model: gtx
    provider: google-translate
    source_hash: b49ae50e5d306612f89f93a86236188a4f2ec23f667e2388b043832be3ac1546
    source_path: help/environment.md
    workflow: 15
---

# 환경변수

OpenClaw는 여러 소스에서 환경 변수를 가져옵니다. 규칙은 **기존 값을 재정의하지 마십시오.**.

## 우선순위(가장 높음 → 가장 낮음)

1. **공정환경** (게이트웨이 프로세스가 상위 쉘/데몬으로부터 이미 가지고 있는 것).
2. **`.env` 현재 작업 디렉토리에서** (dotenv 기본값, 재정의되지 않음)
3. **글로벌 `.env`** ~에 `~/.openclaw/.env` (일명 `$OPENCLAW_STATE_DIR/.env`; 재정의되지 않습니다).
4. **구성 `env` 차단하다** ~에 `~/.openclaw/openclaw.json` (누락된 경우에만 적용)
5. **선택적 로그인 쉘 가져오기** (`env.shellEnv.enabled` 또는 `OPENCLAW_LOAD_SHELL_ENV=1`), 예상 키가 누락된 경우에만 적용됩니다.

구성 파일이 완전히 누락된 경우 4단계를 건너뜁니다. 활성화된 경우 쉘 가져오기가 계속 실행됩니다.

## 구성 `env` 차단하다

인라인 환경 변수를 설정하는 두 가지 동등한 방법(둘 다 재정의되지 않음):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## 쉘 환경 가져오기

`env.shellEnv` 로그인 셸을 실행하고 가져오기만 합니다. **없어진** 예상 키:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var에 해당:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 구성의 Env var 대체

다음을 사용하여 구성 문자열 값에서 환경 변수를 직접 참조할 수 있습니다. `${VAR_NAME}` 통사론:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

보다 [구성: Env var 대체](/gateway/configuration#env-var-substitution-in-config) 자세한 내용은

## 관련된

- [게이트웨이 구성](/gateway/configuration)
- [FAQ: 환경 변수 및 .env 로딩](/help/faq#env-vars-and-env-loading)
- [모델 개요](/concepts/models)
