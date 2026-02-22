---
summary: "모델 인증: OAuth, API 키, setup-token"
read_when:
  - 모델 인증 또는 OAuth 만료 문제 디버깅
  - 인증 또는 자격 증명 저장소 문서화
title: "인증"
---

# 인증 (Authentication)

OpenClaw는 모델 프로바이더에 대해 OAuth와 API 키를 지원합니다. Anthropic 계정의 경우
**API 키** 사용을 권장합니다. Claude 구독 접근의 경우 `claude setup-token`으로 생성된
장기 유효 토큰을 사용하세요.

전체 OAuth 흐름 및 저장 구조는 [/concepts/oauth](/ko-KR/concepts/oauth)를 참조하세요.

## 권장 Anthropic 설정 (API 키)

Anthropic을 직접 사용하는 경우 API 키를 사용하세요.

1. Anthropic 콘솔에서 API 키를 생성합니다.
2. **게이트웨이 호스트** (`openclaw gateway`를 실행하는 머신)에 저장합니다.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 게이트웨이가 systemd/launchd에서 실행되는 경우, 데몬이 읽을 수 있도록
   `~/.openclaw/.env`에 키를 저장하는 것이 좋습니다:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

그런 다음 데몬을 재시작하고(또는 게이트웨이 프로세스를 재시작) 다시 확인하세요:

```bash
openclaw models status
openclaw doctor
```

환경 변수를 직접 관리하고 싶지 않다면, 온보딩 마법사를 통해 데몬용 API 키를
저장할 수 있습니다: `openclaw onboard`.

환경 변수 상속(`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd)에 대한 자세한 내용은
[도움말](/ko-KR/help)을 참조하세요.

## Anthropic: setup-token (구독 인증)

Anthropic의 경우 권장 방법은 **API 키**입니다. Claude 구독을 사용하는 경우
setup-token 흐름도 지원됩니다. **게이트웨이 호스트**에서 실행하세요:

```bash
claude setup-token
```

그런 다음 OpenClaw에 붙여넣기 하세요:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우 수동으로 붙여넣기 하세요:

```bash
openclaw models auth paste-token --provider anthropic
```

다음과 같은 Anthropic 오류가 발생하면:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…대신 Anthropic API 키를 사용하세요.

수동 토큰 입력 (모든 프로바이더; `auth-profiles.json` 작성 + 설정 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

자동화에 친화적인 확인 (만료/누락 시 종료 코드 `1`, 만료 예정 시 `2`):

```bash
openclaw models status --check
```

선택적 운영 스크립트 (systemd/Termux)는 여기에 문서화되어 있습니다:
[/automation/auth-monitoring](/ko-KR/automation/auth-monitoring)

> `claude setup-token`은 대화형 TTY가 필요합니다.

## 모델 인증 상태 확인

```bash
openclaw models status
openclaw doctor
```

## API 키 순환 동작 (게이트웨이)

일부 프로바이더는 API 호출이 프로바이더 속도 제한에 걸렸을 때 대체 키로 요청을
재시도하는 것을 지원합니다.

- 우선 순위:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (단일 재정의)
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google 프로바이더는 추가 대안으로 `GOOGLE_API_KEY`도 포함합니다.
- 사용 전 동일한 키 목록에서 중복이 제거됩니다.
- OpenClaw는 속도 제한 오류(예: `429`, `rate_limit`, `quota`, `resource exhausted`)에
  대해서만 다음 키로 재시도합니다.
- 속도 제한이 아닌 오류는 대체 키로 재시도하지 않습니다.
- 모든 키가 실패하면 마지막 시도의 최종 오류가 반환됩니다.

## 사용할 자격 증명 제어

### 세션별 (채팅 명령)

현재 세션에 특정 프로바이더 자격 증명을 고정하려면 `/model <별칭-또는-id>@<profileId>`를
사용하세요 (프로파일 ID 예시: `anthropic:default`, `anthropic:work`).

간단한 선택기에는 `/model` (또는 `/model list`)을 사용하고, 후보 + 다음 인증 프로파일,
설정된 경우 프로바이더 엔드포인트 세부 정보를 포함한 전체 보기에는 `/model status`를
사용하세요.

### 에이전트별 (CLI 재정의)

에이전트에 대한 명시적 인증 프로파일 순서 재정의를 설정합니다 (해당 에이전트의
`auth-profiles.json`에 저장됨):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 대상으로 하려면 `--agent <id>`를 사용하고, 생략하면 설정된 기본 에이전트를
사용합니다.

## 문제 해결

### "자격 증명을 찾을 수 없음"

Anthropic 토큰 프로파일이 없는 경우 **게이트웨이 호스트**에서 `claude setup-token`을
실행한 후 다시 확인하세요:

```bash
openclaw models status
```

### 토큰 만료 예정/만료됨

`openclaw models status`를 실행하여 어떤 프로파일이 만료되는지 확인하세요. 프로파일이
없는 경우 `claude setup-token`을 다시 실행하고 토큰을 다시 붙여넣기 하세요.

## 요구 사항

- Claude Max 또는 Pro 구독 (`claude setup-token` 사용 시)
- Claude Code CLI 설치됨 (`claude` 명령 사용 가능)
