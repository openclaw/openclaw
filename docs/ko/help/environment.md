---
summary: "OpenClaw 가 환경 변수를 로드하는 위치와 우선순위 순서"
read_when:
  - 어떤 환경 변수가 로드되는지와 그 순서를 알아야 할 때
  - Gateway(게이트웨이) 에서 API 키 누락을 디버깅할 때
  - 프로바이더 인증 또는 배포 환경을 문서화할 때
title: "환경 변수"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:10Z
---

# 환경 변수

OpenClaw 는 여러 소스에서 환경 변수를 가져옵니다. 규칙은 **기존 값을 절대 덮어쓰지 않는 것**입니다.

## 우선순위 (높음 → 낮음)

1. **프로세스 환경** (Gateway(게이트웨이) 프로세스가 상위 셸 또는 데몬에서 이미 가지고 있는 값).
2. **현재 작업 디렉토리의 `.env`** (dotenv 기본값; 덮어쓰지 않음).
3. **`~/.openclaw/.env` 에 있는 전역 `.env`** (일명 `$OPENCLAW_STATE_DIR/.env`; 덮어쓰지 않음).
4. **`~/.openclaw/openclaw.json` 의 Config `env` 블록** (누락된 경우에만 적용).
5. **선택적 로그인 셸 가져오기** (`env.shellEnv.enabled` 또는 `OPENCLAW_LOAD_SHELL_ENV=1`), 예상되는 키 중 누락된 항목에만 적용.

구성 파일이 완전히 없는 경우 4단계는 건너뜁니다. 셸 가져오기는 활성화되어 있으면 여전히 실행됩니다.

## Config `env` 블록

인라인 환경 변수를 설정하는 두 가지 동등한 방법이 있습니다 (둘 다 덮어쓰지 않음):

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

## 셸 환경 변수 가져오기

`env.shellEnv` 는 로그인 셸을 실행하고 **누락된** 예상 키만 가져옵니다:

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

환경 변수 동등 항목:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 구성에서의 환경 변수 치환

구성 문자열 값에서 `${VAR_NAME}` 구문을 사용하여 환경 변수를 직접 참조할 수 있습니다:

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

자세한 내용은 [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) 을 참고하십시오.

## 관련 항목

- [Gateway 구성](/gateway/configuration)
- [FAQ: 환경 변수와 .env 로딩](/help/faq#env-vars-and-env-loading)
- [모델 개요](/concepts/models)
