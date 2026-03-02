---
summary: "모델 인증: OAuth, API 키 및 설정 토큰"
read_when:
  - 모델 인증 또는 OAuth 만료를 디버깅할 때
  - 인증 또는 자격 증명 저장소를 문서화할 때
title: "인증"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/authentication.md
  workflow: 15
---

# 인증

OpenClaw 는 모델 공급자에 대해 OAuth 및 API 키를 지원합니다. Anthropic 계정의 경우 **API 키** 사용을 권장합니다. Claude 구독 액세스의 경우 `claude setup-token` 으로 생성한 오래 지속되는 토큰을 사용합니다.

OAuth 흐름 및 저장소 레이아웃의 전체는 [/concepts/oauth](/concepts/oauth) 를 참조하세요.
SecretRef 기반 인증 (`env`/`file`/`exec` 공급자) 의 경우 [암호 관리](/gateway/secrets) 를 참조하세요.

## 권장 Anthropic 설정 (API 키)

Anthropic 를 직접 사용하는 경우 API 키를 사용합니다.

1. Anthropic Console 에서 API 키를 만듭니다.
2. **Gateway 호스트** (openclaw gateway 를 실행하는 머신) 에 배치합니다.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gateway 가 systemd/launchd 에서 실행되면 대신 키를 `~/.openclaw/.env` 에 배치하는 것을 선호합니다.
   데몬이 읽을 수 있습니다:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

그러면 데몬 (또는 Gateway 프로세스) 을 재시작하고 다시 확인합니다:

```bash
openclaw models status
openclaw doctor
```

환경 변수를 직접 관리하지 않으려면 온보딩 마법사가 데몬 사용에 대한 API 키를 저장할 수 있습니다: `openclaw onboard`.

환경 상속 (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd) 의 세부 사항은 [도움말](/help) 를 참조하세요.

## Anthropic: setup-token (구독 인증)

Anthropic 의 경우 권장 경로는 **API 키**입니다. Claude 구독을 사용하는 경우 setup-token 흐름도 지원됩니다. **Gateway 호스트** 에서 실행합니다:

```bash
claude setup-token
```

그러면 OpenClaw 에 붙여넣습니다:

```bash
openclaw models auth setup-token --provider anthropic
```

토큰이 다른 머신에서 생성된 경우 수동으로 붙여넣습니다:

```bash
openclaw models auth paste-token --provider anthropic
```

다음과 같은 Anthropic 오류가 보이면:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

… 대신 Anthropic API 키를 사용합니다.

수동 토큰 항목 (모든 공급자; `auth-profiles.json` 작성 + 구성 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

인증 프로필 참고도 정적 자격 증명에 대해 지원됩니다:

- `api_key` 자격 증명은 `keyRef: { source, provider, id }` 를 사용할 수 있습니다.
- `token` 자격 증명은 `tokenRef: { source, provider, id }` 를 사용할 수 있습니다.

자동화 친화적 확인 (만료/누락 시 `1` 종료, 만료 시 `2`):

```bash
openclaw models status --check
```

선택적 운영 스크립트 (systemd/Termux) 는 여기에 문서화되어 있습니다:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 대화형 TTY 가 필요합니다.

## 모델 인증 상태 확인

```bash
openclaw models status
openclaw doctor
```

## API 키 회전 동작 (Gateway)

일부 공급자는 API 호출이 공급자 속도 제한을 받을 때 대체 키로 요청을 재시도하도록 지원합니다.

- 우선순위:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (단일 오버라이드)
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google 공급자도 추가 대체로 `GOOGLE_API_KEY` 포함합니다.
- 동일한 키 목록은 사용 전에 중복 제거됩니다.
- OpenClaw 는 속도 제한 오류 (예: `429`, `rate_limit`, `quota`, `resource exhausted`) 에서만 다음 키로 재시도합니다.
- 비율 제한 오류는 대체 키로 재시도되지 않습니다.
- 모든 키가 실패하면 마지막 시도의 최종 오류가 반환됩니다.

## 사용되는 자격 증명 제어

### 세션별 (채팅 명령)

현재 세션에 대해 특정 공급자 자격 증명을 고정하려면 `/model <alias-or-id>@<profileId>` 를 사용합니다 (예: 프로필 ID: `anthropic:default`, `anthropic:work`).

`/model` (또는 `/model list`) 를 컴팩트 선택기에 사용합니다; `/model status` 를 전체 보기 (후보 + 다음 인증 프로필, 구성된 공급자 끝점 세부 포함) 에 사용합니다.

### 에이전트별 (CLI 오버라이드)

에이전트 (해당 에이전트의 `auth-profiles.json` 에 저장됨) 에 대한 명시적 인증 프로필 순서 오버라이드를 설정합니다:

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 대상으로 하려면 `--agent <id>` 를 사용합니다; 구성된 기본 에이전트를 사용하려면 생략합니다.

## 문제 해결

### "자격 증명을 찾을 수 없습니다"

Anthropic 토큰 프로필이 누락되면 **Gateway 호스트** 에서 `claude setup-token` 를 실행한 다음 다시 확인합니다:

```bash
openclaw models status
```

### 토큰 만료/만료됨

`openclaw models status` 를 실행하여 만료되는 프로필을 확인합니다. 프로필이 누락되면 `claude setup-token` 를 다시 실행하고 토큰을 다시 붙여넣습니다.

## 요구 사항

- Claude Max 또는 Pro 구독 (`claude setup-token`)
- Claude Code CLI 설치됨 (`claude` 명령 사용 가능)
