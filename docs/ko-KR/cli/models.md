---
summary: "`openclaw models`에 대한 CLI 참고문서 (상태/목록/설정/스캔, 별칭, 폴백, 인증)"
read_when:
  - 기본 모델을 변경하거나 프로바이더 인증 상태를 확인하려고 할 때
  - 사용 가능한 모델/프로바이더를 스캔하고 인증 프로필을 디버그하려고 할 때
title: "모델"
---

# `openclaw models`

모델 검색, 스캔 및 설정 (기본 모델, 폴백, 인증 프로필).

관련 항목:

- 프로바이더 + 모델: [모델](/providers/models)
- 프로바이더 인증 설정: [시작하기](/start/getting-started)

## 일반 명령어

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status`는 해결된 기본/폴백과 함께 인증 개요를 보여줍니다.
프로바이더 사용 스냅샷이 available한 경우, OAuth/토큰 상태 섹션에는
프로바이더 사용 헤더가 포함됩니다.
각 구성된 프로바이더 프로필에 대해 실시간 인증 프로브를 실행하려면 `--probe`를 추가하세요.
프루브는 실제 요청이며 (토큰을 소비할 수 있고, 속도 제한을 초래할 수 있음).
구성된 에이전트의 모델/인증 상태를 조사하려면 `--agent <id>`를 사용하세요. 생략할 경우
`OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`를 사용하며, 설정되지 않았다면
구성된 기본 에이전트를 사용합니다.

주의사항:

- `models set <model-or-alias>`는 `provider/model` 또는 별칭을 허용합니다.
- 모델 참조는 **첫 번째** `/` 기준으로 나누어 해석됩니다. 모델 ID에 `/`가 포함된 경우 (OpenRouter-스타일), 프로바이더 접두사를 포함해야 합니다 (예: `openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략할 경우, OpenClaw는 입력을 기본 프로바이더에 대한 별칭 또는 모델로 취급합니다 (모델 ID에 `/`이 없을 경우에만 작동).

### `models status`

옵션:

- `--json`
- `--plain`
- `--check` (종료 1=만료/누락, 2=만료 예정)
- `--probe` (구성된 인증 프로필의 실시간 프로브)
- `--probe-provider <name>` (단일 프로바이더 프로브)
- `--probe-profile <id>` (반복 또는 쉼표로 구분된 프로필 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (구성된 에이전트 ID; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`를 무시합니다)

## 별칭 + 폴백

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

`models auth login`은 프로바이더 플러그인의 인증 흐름 (OAuth/API 키)를 실행합니다.
설치된 프로바이더를 보려면 `openclaw plugins list`를 사용하세요.

주의사항:

- `setup-token`은 설정 토큰 값을 묻습니다 (어떤 기계에서든 `claude setup-token`으로 생성하세요).
- `paste-token`은 다른 곳에서 생성된 토큰 문자열이나 자동화에서 생성된 토큰 문자열을 허용합니다.
