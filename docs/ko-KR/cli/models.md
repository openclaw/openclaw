---
summary: "CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks, auth)"
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
title: "models"
x-i18n:
  source_hash: 923b6ffc7de382ba25bc6e699f0515607e74877b39f2136ccdba2d99e1b1e9c3
---

# `openclaw models`

모델 검색, 검색 및 구성(기본 모델, 대체, 인증 프로필)

관련 항목:

- 제공자 + 모델: [모델](/providers/models)
- 공급자 인증 설정: [시작하기](/start/getting-started)

## 일반적인 명령

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status`는 해결된 기본값/대체와 인증 개요를 보여줍니다.
공급자 사용량 스냅샷을 사용할 수 있는 경우 OAuth/토큰 상태 섹션에 다음이 포함됩니다.
공급자 사용 헤더.
구성된 각 공급자 프로필에 대해 실시간 인증 프로브를 실행하려면 `--probe`를 추가하세요.
프로브는 실제 요청입니다(토큰을 소비하고 속도 제한을 트리거할 수 있음).
구성된 에이전트의 모델/인증 상태를 검사하려면 `--agent <id>`을 사용하세요. 생략하는 경우,
설정된 경우 명령은 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`를 사용하고 그렇지 않으면
기본 에이전트를 구성했습니다.

참고:

- `models set <model-or-alias>`는 `provider/model` 또는 별칭을 허용합니다.
- 모델 참조는 **첫 번째** `/`에서 분할하여 구문 분석됩니다. 모델 ID에 `/`(OpenRouter 스타일)가 포함된 경우 공급자 접두사를 포함합니다(예: `openrouter/moonshotai/kimi-k2`).
- 공급자를 생략하면 OpenClaw는 입력을 **기본 공급자**에 대한 별칭 또는 모델로 처리합니다(모델 ID에 `/`가 없는 경우에만 작동합니다).

### `models status`

옵션:

- `--json`
- `--plain`
- `--check` (출구 1=만료됨/없음, 2=만료됨)
- `--probe` (구성된 인증 프로필의 실시간 프로브)
- `--probe-provider <name>` (프로브 1개 제공자)
- `--probe-profile <id>` (반복 또는 쉼표로 구분된 프로필 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (구성된 에이전트 ID, `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` 재정의)

## 별칭 + 대체

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 인증 프로필

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 제공자 플러그인의 인증 흐름(OAuth/API 키)을 실행합니다. 사용
`openclaw plugins list` 어떤 공급자가 설치되어 있는지 확인하세요.

참고:

- `setup-token`는 설정 토큰 값을 묻는 메시지를 표시합니다(모든 머신에서 `claude setup-token`를 사용하여 생성).
- `paste-token`는 다른 곳이나 자동화에서 생성된 토큰 문자열을 허용합니다.
