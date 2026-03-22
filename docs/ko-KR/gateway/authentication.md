---
summary: "모델 인증: OAuth, API 키, 그리고 setup-token"
read_when:
  - 모델 인증 또는 OAuth 만료를 디버깅할 때
  - 인증 또는 자격 증명 저장소를 문서화할 때
title: "인증"
x-i18n:
  source_path: docs/gateway/authentication.md
---

# 인증

OpenClaw은 모델 프로바이더를 위한 OAuth 및 API 키를 지원합니다. 상시 가동 Gateway
호스트의 경우, API 키가 보통 가장 예측 가능한 옵션입니다. 구독/OAuth
플로우도 프로바이더 계정 모델에 맞을 때 지원됩니다.

OAuth 플로우 및 저장 레이아웃 전체는 [/concepts/oauth](/concepts/oauth)를 참고하세요.
SecretRef 기반 인증(`env`/`file`/`exec` 프로바이더)에 대해서는 [시크릿 관리](/gateway/secrets)를 참고하세요.
`models status --probe`에서 사용하는 자격 증명 적격성/이유 코드 규칙은
[인증 자격 증명 의미론](/auth-credential-semantics)을 참고하세요.

## 권장 설정 (API 키, 모든 프로바이더)

장기 실행 Gateway를 운영하는 경우, 선택한 프로바이더의 API 키로 시작하세요.
특히 Anthropic의 경우, API 키 인증이 안전한 경로이며 구독 setup-token
인증보다 권장됩니다.

1. 프로바이더 콘솔에서 API 키를 생성합니다.
2. **Gateway 호스트** (`openclaw gateway`를 실행하는 머신)에 키를 배치합니다.

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. Gateway가 systemd/launchd에서 실행되는 경우, 데몬이 읽을 수 있도록
   `~/.openclaw/.env`에 키를 넣는 것이 좋습니다:

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

그런 다음 데몬을 재시작 (또는 Gateway 프로세스를 재시작)하고 다시 확인합니다:

```bash
openclaw models status
openclaw doctor
```

환경 변수를 직접 관리하고 싶지 않다면, 온보딩에서 데몬 사용을 위한
API 키를 저장할 수 있습니다: `openclaw onboard`.

환경 상속에 대한 자세한 내용은 [도움말](/help)을 참고하세요 (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (구독 인증)

Claude 구독을 사용하는 경우, setup-token 플로우가 지원됩니다. **Gateway 호스트**에서
실행하세요:

```bash
claude setup-token
```

그런 다음 OpenClaw에 붙여넣습니다:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우, 수동으로 붙여넣습니다:

```bash
openclaw models auth paste-token --provider anthropic
```

다음과 같은 Anthropic 오류가 표시되면:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

...Anthropic API 키를 대신 사용하세요.

<Warning>
Anthropic setup-token 지원은 기술적 호환성만을 위한 것입니다. Anthropic은
과거에 Claude Code 외부에서의 일부 구독 사용을 차단한 적이 있습니다. 정책 위험이
수용 가능하다고 판단한 경우에만 사용하고, 현재 Anthropic 약관을 직접 확인하세요.
</Warning>

수동 토큰 입력 (모든 프로바이더; `auth-profiles.json` 작성 + 설정 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

정적 자격 증명에 대한 인증 프로필 참조도 지원됩니다:

- `api_key` 자격 증명은 `keyRef: { source, provider, id }`를 사용할 수 있습니다
- `token` 자격 증명은 `tokenRef: { source, provider, id }`를 사용할 수 있습니다

자동화 친화적 검사 (만료/누락 시 종료 `1`, 만료 임박 시 `2`):

```bash
openclaw models status --check
```

선택적 운영 스크립트 (systemd/Termux)는 여기에 문서화되어 있습니다:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token`은 대화형 TTY가 필요합니다.

## 모델 인증 상태 확인

```bash
openclaw models status
openclaw doctor
```

## API 키 순환 동작 (Gateway)

일부 프로바이더는 API 호출이 프로바이더 속도 제한에 도달했을 때
대체 키로 요청을 재시도하는 것을 지원합니다.

- 우선순위:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (단일 오버라이드)
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google 프로바이더는 추가 폴백으로 `GOOGLE_API_KEY`도 포함합니다.
- 동일 키 목록은 사용 전에 중복 제거됩니다.
- OpenClaw은 속도 제한 오류(예: `429`, `rate_limit`, `quota`, `resource exhausted`)에 대해서만 다음 키로 재시도합니다.
- 속도 제한이 아닌 오류는 대체 키로 재시도되지 않습니다.
- 모든 키가 실패하면, 마지막 시도의 최종 오류가 반환됩니다.

## 사용할 자격 증명 제어

### 세션별 (채팅 명령)

`/model <alias-or-id>@<profileId>`를 사용하여 현재 세션에 특정 프로바이더 자격 증명을 고정합니다 (프로필 ID 예: `anthropic:default`, `anthropic:work`).

`/model` (또는 `/model list`)로 간단한 선택기를 사용하고, `/model status`로 전체 보기(후보 + 다음 인증 프로필, 설정된 경우 프로바이더 엔드포인트 세부사항 포함)를 확인합니다.

### 에이전트별 (CLI 오버라이드)

에이전트에 대한 명시적 인증 프로필 순서 오버라이드를 설정합니다 (해당 에이전트의 `auth-profiles.json`에 저장됨):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

`--agent <id>`를 사용하여 특정 에이전트를 대상으로 합니다. 생략하면 설정된 기본 에이전트를 사용합니다.

## 문제 해결

### "No credentials found"

Anthropic 토큰 프로필이 누락된 경우, **Gateway 호스트**에서 `claude setup-token`을 실행한 다음 다시 확인합니다:

```bash
openclaw models status
```

### 토큰 만료 임박/만료됨

`openclaw models status`를 실행하여 어떤 프로필이 만료되는지 확인합니다. 프로필이
누락된 경우, `claude setup-token`을 다시 실행하고 토큰을 다시 붙여넣습니다.

## 요구 사항

- Anthropic 구독 계정 (`claude setup-token`용)
- Claude Code CLI 설치됨 (`claude` 명령어 사용 가능)
