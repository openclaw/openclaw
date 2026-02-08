---
read_when:
    - 기본 모델을 변경하거나 공급자 인증 상태를 보고 싶습니다.
    - 사용 가능한 모델/공급자를 검색하고 인증 프로필을 디버그하고 싶습니다.
summary: '`openclaw models`에 대한 CLI 참조(상태/목록/설정/스캔, 별칭, 대체, 인증)'
title: 모델
x-i18n:
    generated_at: "2026-02-08T15:49:17Z"
    model: gtx
    provider: google-translate
    source_hash: 923b6ffc7de382ba25bc6e699f0515607e74877b39f2136ccdba2d99e1b1e9c3
    source_path: cli/models.md
    workflow: 15
---

# `openclaw models`

모델 검색, 검색 및 구성(기본 모델, 대체, 인증 프로필)

관련된:

- 공급자 + 모델: [모델](/providers/models)
- 공급자 인증 설정: [시작하기](/start/getting-started)

## 일반적인 명령

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 해결된 기본값/대체와 인증 개요를 보여줍니다.
공급자 사용량 스냅샷을 사용할 수 있는 경우 OAuth/토큰 상태 섹션에 다음이 포함됩니다.
공급자 사용 헤더.
추가하다 `--probe` 구성된 각 공급자 프로필에 대해 실시간 인증 프로브를 실행합니다.
프로브는 실제 요청입니다(토큰을 소비하고 속도 제한을 트리거할 수 있음).
사용 `--agent <id>` 구성된 에이전트의 모델/인증 상태를 검사합니다. 생략하는 경우,
명령은 다음을 사용합니다 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` 설정되어 있으면 그렇지 않으면
기본 에이전트를 구성했습니다.

참고:

- `models set <model-or-alias>` 받아들인다 `provider/model` 또는 별칭.
- 모델 참조는 분할하여 구문 분석됩니다. **첫 번째** `/`. 모델 ID에 다음이 포함된 경우 `/` (OpenRouter 스타일), 공급자 접두사를 포함합니다(예: `openrouter/moonshotai/kimi-k2`).
- 공급자를 생략하면 OpenClaw는 입력을 별칭이나 모델로 처리합니다. **기본 공급자** (없을 때만 작동합니다. `/` 모델 ID에서).

### `models status`

옵션:

- `--json`
- `--plain`
- `--check` (출구 1=만료됨/누락됨, 2=만료됨)
- `--probe` (구성된 인증 프로필의 실시간 프로브)
- `--probe-provider <name>` (하나의 제공자 조사)
- `--probe-profile <id>` (반복하거나 쉼표로 구분된 프로필 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (구성된 에이전트 ID, 재정의 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

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

`models auth login` 공급자 플러그인의 인증 흐름(OAuth/API 키)을 실행합니다. 사용
`openclaw plugins list` 어떤 공급자가 설치되어 있는지 확인하세요.

참고:

- `setup-token` 설정 토큰 값을 묻는 메시지가 표시됩니다(다음을 사용하여 생성). `claude setup-token` 모든 기계에서).
- `paste-token` 다른 곳이나 자동화에서 생성된 토큰 문자열을 허용합니다.
