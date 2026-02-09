---
summary: "모델 인증: OAuth, API 키 및 setup-token"
read_when:
  - 모델 인증 또는 OAuth 만료 디버깅
  - 인증 또는 자격 증명 저장 문서화
title: "인증"
---

# 인증

OpenClaw 는 모델 프로바이더에 대해 OAuth 와 API 키를 지원합니다. Anthropic
계정의 경우 **API 키** 사용을 권장합니다. Claude 구독 액세스의 경우,
`claude setup-token` 에서 생성된 장기 수명 토큰을 사용하십시오.

전체 OAuth 흐름과 저장 레이아웃은 [/concepts/oauth](/concepts/oauth) 를 참고하십시오.

## 권장 Anthropic 설정 (API 키)

Anthropic 을 직접 사용하는 경우 API 키를 사용하십시오.

1. Anthropic Console 에서 API 키를 생성합니다.
2. **Gateway 호스트**(`openclaw gateway` 을 실행하는 머신)에 설정합니다.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gateway 가 systemd/launchd 하에서 실행되는 경우, 데몬이 읽을 수 있도록
   `~/.openclaw/.env` 에 키를 두는 것을 권장합니다.

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

그런 다음 데몬을 재시작(또는 Gateway 프로세스를 재시작)하고 다시 확인하십시오.

```bash
openclaw models status
openclaw doctor
```

환경 변수를 직접 관리하고 싶지 않다면, 온보딩 마법사가 데몬 사용을 위해
API 키를 저장할 수 있습니다: `openclaw onboard`.

환경 상속(`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd)에 대한 자세한 내용은
[Help](/help) 를 참고하십시오.

## Anthropic: setup-token (구독 인증)

Anthropic 에서는 **API 키**가 권장 경로입니다. Claude 구독을 사용하는 경우,
setup-token 흐름도 지원됩니다. **Gateway 호스트**에서 실행하십시오.

```bash
claude setup-token
```

그런 다음 OpenClaw 에 붙여넣습니다.

```bash
openclaw models auth setup-token --provider anthropic
```

토큰이 다른 머신에서 생성된 경우 수동으로 붙여넣으십시오.

```bash
openclaw models auth paste-token --provider anthropic
```

다음과 같은 Anthropic 오류가 표시되면,

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…대신 Anthropic API 키를 사용하십시오.

수동 토큰 입력(모든 프로바이더; `auth-profiles.json` 에 기록 + 설정 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

자동화 친화적 확인(만료/누락 시 종료 코드 `1`, 만료 임박 시 `2`):

```bash
openclaw models status --check
```

선택적 운영 스크립트(systemd/Termux)는 다음에 문서화되어 있습니다:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 는 인터랙티브 TTY 가 필요합니다.

## 모델 인증 상태 확인

```bash
openclaw models status
openclaw doctor
```

## 사용될 자격 증명 제어

### 세션별 (채팅 명령)

현재 세션에 대해 특정 프로바이더 자격 증명을 고정하려면 `/model <alias-or-id>@<profileId>` 를 사용하십시오
(예시 프로필 ID: `anthropic:default`, `anthropic:work`).

간결한 선택기는 `/model` (또는 `/model list`) 를 사용하고,
전체 보기(후보 + 다음 인증 프로필, 구성된 경우 프로바이더 엔드포인트 세부 정보 포함)는
`/model status` 를 사용하십시오.

### 에이전트별 (CLI 오버라이드)

에이전트에 대해 명시적인 인증 프로필 순서 오버라이드를 설정합니다
(해당 에이전트의 `auth-profiles.json` 에 저장됨).

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 대상으로 하려면 `--agent <id>` 를 사용하십시오. 생략하면 구성된 기본 에이전트를 사용합니다.

## 문제 해결

### “자격 증명을 찾을 수 없음”

Anthropic 토큰 프로필이 누락된 경우 **Gateway 호스트**에서 `claude setup-token` 를 실행한 뒤,
다시 확인하십시오.

```bash
openclaw models status
```

### 토큰 만료 임박/만료

어떤 프로필이 만료 중인지 확인하려면 `openclaw models status` 를 실행하십시오. 프로필이 누락된 경우 `claude setup-token` 를 다시 실행하고 토큰을 다시 붙여넣으십시오.

## 요구 사항

- Claude Max 또는 Pro 구독(`claude setup-token` 용)
- Claude Code CLI 설치됨(`claude` 명령 사용 가능)
