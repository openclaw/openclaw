---
summary: "OpenClaw 가 환경 변수를 불러오는 위치와 우선순위"
read_when:
  - 로딩되는 환경 변수와 그 순서를 알아야 하는 경우
  - 게이트웨이에서 API 키가 누락된 것을 디버깅하는 경우
  - 프로바이더 인증 또는 배포 환경을 문서화하는 경우
title: "환경 변수"
---

# 환경 변수

OpenClaw는 여러 소스에서 환경 변수를 가져옵니다. **기존 값을 절대 덮어쓰지 않는다**는 규칙이 있습니다.

## 우선순위 (높음 → 낮음)

1. **프로세스 환경** (게이트웨이 프로세스가 부모 셸/데몬에서 이미 가지고 있는 것).
2. **현재 작업 디렉토리의 `.env`** (dotenv 기본값; 덮어쓰지 않음).
3. **글로벌 `.env`** 위치: `~/.openclaw/.env` (또는 `$OPENCLAW_STATE_DIR/.env`; 덮어쓰지 않음).
4. `~/.openclaw/openclaw.json`의 **설정 `env` 블록** (누락된 경우에만 적용).
5. **옵션 로그인-셸 가져오기** (`env.shellEnv.enabled` 또는 `OPENCLAW_LOAD_SHELL_ENV=1`), 누락된 예상 키에만 적용.

구성 파일이 완전히 없으면 4단계는 건너뜁니다. 셸 가져오기는 활성화된 경우 여전히 실행됩니다.

## 설정 `env` 블록

다음 두 가지 방법으로 인라인 환경 변수를 설정할 수 있습니다 (둘 다 덮어쓰지 않음):

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

## 셸 환경 가져오기

`env.shellEnv`는 로그인 셸을 실행하고 누락된 예상 키만 가져옵니다:

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

환경 변수 동등값:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 설정에서의 환경 변수 대체

설정 문자열 값에 `${VAR_NAME}` 구문을 사용하여 환경 변수를 직접 참조할 수 있습니다:

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

자세한 내용은 [Configuration: Env var substitution](/ko-KR/gateway/configuration#env-var-substitution-in-config)을 참조하십시오.

## 경로 관련 환경 변수

| 변수                    | 목적                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`       | 모든 내부 경로 해석에 사용되는 홈 디렉토리를 재정의합니다 (`~/.openclaw/`, 에이전트 디렉토리, 세션, 자격 증명). OpenClaw를 전용 서비스 사용자로 실행할 때 유용합니다.                      |
| `OPENCLAW_STATE_DIR`  | 상태 디렉토리를 재정의합니다 (기본값 `~/.openclaw`).                                                                                                                                |
| `OPENCLAW_CONFIG_PATH`| 설정 파일 경로를 재정의합니다 (기본값 `~/.openclaw/openclaw.json`).                                                                                                                 |

### `OPENCLAW_HOME`

설정된 경우, `OPENCLAW_HOME`은 모든 내부 경로 해석에 대해 시스템 홈 디렉토리 (`$HOME` / `os.homedir()`)를 대체합니다. 이는 헤드리스 서비스 계정에 대한 전체 파일 시스템 격리를 가능하게 합니다.

**우선순위:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**예시** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME`은 틸드 경로 (예: `~/svc`)로 설정할 수도 있으며, 이 경로는 사용 전에 `$HOME`을 사용하여 확장됩니다.

## 관련 항목

- [게이트웨이 구성](/ko-KR/gateway/configuration)
- [FAQ: 환경 변수 및 .env 로딩](/ko-KR/help/faq#env-vars-and-env-loading)
- [모델 개요](/ko-KR/concepts/models)
