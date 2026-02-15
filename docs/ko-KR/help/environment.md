---
summary: "Where OpenClaw loads environment variables and the precedence order"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
title: "Environment Variables"
x-i18n:
  source_hash: b9c746f663651c84c48667388e57c8bba630e6bd2ba930119da5b4fbf54f90ad
---

# 환경변수

OpenClaw는 여러 소스에서 환경 변수를 가져옵니다. 규칙은 **기존 값을 재정의하지 마세요**입니다.

## 우선순위(가장 높음 → 가장 낮음)

1. **프로세스 환경**(게이트웨이 프로세스가 상위 셸/데몬으로부터 이미 가지고 있는 것).
2. 현재 작업 디렉터리의 **`.env`**(dotenv 기본값, 재정의되지 않음).
3. **`.env`** `~/.openclaw/.env`(일명 `$OPENCLAW_STATE_DIR/.env`; 재정의되지 않음)의 전역 `.env`\*\*.
4. `~/.openclaw/openclaw.json`에 **`env` 블록**을 구성합니다(누락된 경우에만 적용).
5. **선택적 로그인 셸 가져오기**(`env.shellEnv.enabled` 또는 `OPENCLAW_LOAD_SHELL_ENV=1`), 예상 키가 누락된 경우에만 적용됩니다.

구성 파일이 완전히 누락된 경우 4단계를 건너뜁니다. 활성화된 경우 쉘 가져오기가 계속 실행됩니다.

## `env` 블록 구성

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

`env.shellEnv`는 로그인 셸을 실행하고 **누락된** 예상 키만 가져옵니다.

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

## 구성에서 Env var 대체

`${VAR_NAME}` 구문을 사용하여 구성 문자열 값에서 환경 변수를 직접 참조할 수 있습니다.

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

자세한 내용은 [구성: 환경 변수 대체](/gateway/configuration#env-var-substitution-in-config)를 참조하세요.

## 경로 관련 환경 변수

| 변수                   | 목적                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | 모든 내부 경로 확인(`~/.openclaw/`, 에이전트 디렉터리, 세션, 자격 증명)에 사용되는 홈 디렉터리를 재정의합니다. OpenClaw를 전용 서비스 사용자로 실행할 때 유용합니다. |
| `OPENCLAW_STATE_DIR`   | 상태 디렉터리를 재정의합니다(기본값 `~/.openclaw`).                                                                                                                  |
| `OPENCLAW_CONFIG_PATH` | 구성 파일 경로를 재정의합니다(기본값 `~/.openclaw/openclaw.json`).                                                                                                   |

### `OPENCLAW_HOME`

설정되면 `OPENCLAW_HOME`는 모든 내부 경로 확인을 위해 시스템 홈 디렉터리(`$HOME` / `os.homedir()`)를 대체합니다. 이를 통해 헤드리스 서비스 계정에 대한 전체 파일 시스템 격리가 가능해집니다.

**우선순위:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**예**(macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME`는 물결표 경로(예: `~/svc`)로 설정할 수도 있으며, 사용하기 전에 `$HOME`를 사용하여 확장됩니다.

## 관련

- [게이트웨이 구성](/gateway/configuration)
- [FAQ: 환경 변수 및 .env 로딩](/help/faq#env-vars-and-env-loading)
- [모델 개요](/concepts/models)
