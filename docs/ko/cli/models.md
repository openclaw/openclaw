---
summary: "`openclaw models`에 대한 CLI 참조 (status/list/set/scan, 별칭, 폴백, 인증)"
read_when:
  - 기본 모델을 변경하거나 프로바이더 인증 상태를 확인하려는 경우
  - 사용 가능한 모델/프로바이더를 스캔하고 인증 프로필을 디버그하려는 경우
title: "models"
---

# `openclaw models`

모델 디바이스 검색, 스캔, 및 구성 (기본 모델, 폴백, 인증 프로필).

관련 항목:

- 프로바이더 + 모델: [Models](/providers/models)
- 프로바이더 인증 설정: [시작하기](/start/getting-started)

## Common commands

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 는 해결된 기본/폴백과 인증 개요를 표시합니다.
프로바이더 사용 스냅샷을 사용할 수 있는 경우, OAuth/토큰 상태 섹션에
프로바이더 사용 헤더가 포함됩니다.
각 구성된 프로바이더 프로필에 대해 실시간 인증 프로브를 실행하려면 `--probe` 를 추가하십시오.
프로브는 실제 요청입니다 (토큰을 소모하거나 속도 제한을 유발할 수 있습니다).
구성된 에이전트의 모델/인증 상태를 검사하려면 `--agent <id>` 를 사용하십시오. 이를 생략하면,
설정된 경우 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` 를 사용하고, 그렇지 않으면
구성된 기본 에이전트를 사용합니다.

Notes:

- `models set <model-or-alias>` 는 `provider/model` 또는 별칭을 허용합니다.
- 모델 참조는 **첫 번째** `/` 를 기준으로 분리하여 파싱됩니다. 모델 ID에 `/` (OpenRouter 스타일)가 포함된 경우, 프로바이더 접두사를 포함하십시오 (예: `openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략하면, OpenClaw 는 입력을 **기본 프로바이더**에 대한 별칭 또는 모델로 처리합니다 (모델 ID에 `/` 가 없는 경우에만 동작).

### `models status`

Options:

- `--json`
- `--plain`
- `--check` (종료 코드 1=만료/누락, 2=만료 임박)
- `--probe` (구성된 인증 프로필의 실시간 프로브)
- `--probe-provider <name>` (단일 프로바이더 프로브)
- `--probe-profile <id>` (반복 또는 콤마로 구분된 프로필 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (구성된 에이전트 ID; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` 를 재정의)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 는 프로바이더 플러그인의 인증 흐름 (OAuth/API 키)을 실행합니다. 설치된 프로바이더를 확인하려면
`openclaw plugins list` 를 사용하십시오.

Notes:

- `setup-token` 는 설정 토큰 값을 요청합니다 (어떤 머신에서든 `claude setup-token` 로 생성하십시오).
- `paste-token` 는 다른 곳에서 생성되었거나 자동화에서 생성된 토큰 문자열을 허용합니다.
