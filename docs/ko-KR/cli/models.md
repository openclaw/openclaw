---
summary: "`openclaw models` CLI 레퍼런스 (status/list/set/scan, 별칭, 폴백, 인증)"
read_when:
  - 기본 모델을 변경하거나 프로바이더 인증 상태를 확인하고 싶을 때
  - 사용 가능한 모델/프로바이더를 스캔하고 인증 프로필을 디버깅할 때
title: "models"
x-i18n:
  source_path: "docs/cli/models.md"
---

# `openclaw models`

모델 검색, 스캐닝 및 설정 (기본 모델, 폴백, 인증 프로필).

관련 문서:

- 프로바이더 + 모델: [Models](/providers/models)
- 프로바이더 인증 설정: [Getting started](/start/getting-started)

## 주요 명령어

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status`는 해석된 기본값/폴백과 인증 개요를 표시합니다.
프로바이더 사용량 스냅샷이 가능한 경우, OAuth/토큰 상태 섹션에 프로바이더 사용량 헤더가 포함됩니다.
`--probe`를 추가하면 설정된 각 프로바이더 프로필에 대해 라이브 인증 프로브를 실행합니다.
프로브는 실제 요청입니다 (토큰을 소비하고 속도 제한을 트리거할 수 있습니다).
`--agent <id>`를 사용하면 설정된 에이전트의 모델/인증 상태를 검사합니다. 생략하면 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`이 설정된 경우 이를 사용하고, 그렇지 않으면 설정된 기본 에이전트를 사용합니다.

참고:

- `models set <model-or-alias>`는 `provider/model` 또는 별칭을 받습니다.
- 모델 참조는 **첫 번째** `/`로 분할하여 파싱됩니다. 모델 ID에 `/`가 포함된 경우 (OpenRouter 스타일), 프로바이더 접두사를 포함하세요 (예: `openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략하면 OpenClaw는 입력을 별칭이나 **기본 프로바이더**의 모델로 취급합니다 (모델 ID에 `/`가 없는 경우에만 작동).
- `models status`는 인증 출력에서 비밀이 아닌 자리표시자 (예: `OPENAI_API_KEY`, `secretref-managed`, `minimax-oauth`, `qwen-oauth`, `ollama-local`)에 대해 시크릿으로 마스킹하는 대신 `marker(<value>)`를 표시할 수 있습니다.

### `models status`

옵션:

- `--json`
- `--plain`
- `--check` (exit 1=만료/누락, 2=만료 예정)
- `--probe` (설정된 인증 프로필의 라이브 프로브)
- `--probe-provider <name>` (하나의 프로바이더 프로브)
- `--probe-profile <id>` (반복 또는 쉼표 구분 프로필 id)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (설정된 에이전트 id; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`을 재정의)

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

`models auth login`은 프로바이더 플러그인의 인증 흐름을 실행합니다 (OAuth/API 키). 어떤 프로바이더가 설치되어 있는지 확인하려면 `openclaw plugins list`를 사용하세요.

참고:

- `setup-token`은 setup-token 값을 입력하도록 프롬프트합니다 (아무 머신에서나 `claude setup-token`으로 생성).
- `paste-token`은 다른 곳이나 자동화에서 생성된 토큰 문자열을 받습니다.
- Anthropic 정책 참고: setup-token 지원은 기술적 호환성입니다. Anthropic이 과거에 Claude Code 외부에서의 일부 구독 사용을 차단한 적이 있으므로, 광범위하게 사용하기 전에 현재 약관을 확인하세요.
