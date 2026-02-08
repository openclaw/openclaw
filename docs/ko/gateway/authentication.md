---
read_when:
    - 모델 인증 또는 OAuth 만료 디버깅
    - 인증 또는 자격증명 저장 문서화
summary: '모델 인증: OAuth, API 키 및 설정 토큰'
title: 입증
x-i18n:
    generated_at: "2026-02-08T15:52:44Z"
    model: gtx
    provider: google-translate
    source_hash: 66fa2c64ff374c9cfcdb4e7a951b0d164d512295e65513eb682f12191b75e557
    source_path: gateway/authentication.md
    workflow: 15
---

# 입증

OpenClaw는 모델 공급자를 위한 OAuth 및 API 키를 지원합니다. 인류를 위한
계정을 사용하는 것이 좋습니다. **API 키**. Claude 구독 액세스의 경우,
다음에 의해 생성된 수명이 긴 토큰을 사용합니다. `claude setup-token`.

보다 [/개념/oauth](/concepts/oauth) 전체 OAuth 흐름 및 저장을 위해
레이아웃.

## 권장 인류학 설정(API 키)

Anthropic을 직접 사용하는 경우 API 키를 사용하세요.

1. Anthropic 콘솔에서 API 키를 생성하세요.
2. 에 넣어 **게이트웨이 호스트** (기계가 돌아가고 있어요. `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 게이트웨이가 systemd/launchd에서 실행되는 경우 키를
   `~/.openclaw/.env` 그래서 데몬은 그것을 읽을 수 있습니다:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

그런 다음 데몬을 다시 시작하고(또는 게이트웨이 프로세스를 다시 시작) 다음을 다시 확인하세요.

```bash
openclaw models status
openclaw doctor
```

환경 변수를 직접 관리하고 싶지 않은 경우 온보딩 마법사가 다음을 저장할 수 있습니다.
데몬 사용을 위한 API 키: `openclaw onboard`.

보다 [돕다](/help) 환경 상속에 대한 자세한 내용은 (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: 설정 토큰(구독 인증)

Anthropic의 경우 권장 경로는 다음과 같습니다. **API 키**. 클로드를 사용하는 경우
구독을 사용하는 경우 설정 토큰 흐름도 지원됩니다. 다음에서 실행하세요. **게이트웨이 호스트**:

```bash
claude setup-token
```

그런 다음 OpenClaw에 붙여넣습니다.

```bash
openclaw models auth setup-token --provider anthropic
```

토큰이 다른 컴퓨터에서 생성된 경우 수동으로 붙여넣습니다.

```bash
openclaw models auth paste-token --provider anthropic
```

다음과 같은 Anthropic 오류가 표시되는 경우:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

...대신 Anthropic API 키를 사용하세요.

수동 토큰 입력(모든 공급자, 쓰기 `auth-profiles.json` + 구성 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

자동화 친화적인 검사(종료 `1` 만료/누락된 경우, `2` 만료 시):

```bash
openclaw models status --check
```

선택적 ops 스크립트(systemd/Termux)는 여기에 설명되어 있습니다.
[/자동화/인증 모니터링](/automation/auth-monitoring)

> `claude setup-token` 대화형 TTY가 필요합니다.

## 모델 인증 상태 확인 중

```bash
openclaw models status
openclaw doctor
```

## 어떤 자격 증명이 사용되는지 제어

### 세션별(채팅 명령)

사용 `/model <alias-or-id>@<profileId>` 현재 세션에 대한 특정 공급자 자격 증명을 고정합니다(예: 프로필 ID: `anthropic:default`,`anthropic:work`).

사용 `/model` (또는 `/model list`) 컴팩트 피커의 경우; 사용 `/model status` 전체 보기(후보자 + 다음 인증 프로필, 구성된 경우 공급자 엔드포인트 세부 정보)

### 에이전트별(CLI 재정의)

에이전트에 대한 명시적인 인증 프로필 순서 재정의를 설정합니다(해당 에이전트의 `auth-profiles.json`):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

사용 `--agent <id>` 특정 에이전트를 타겟팅합니다. 구성된 기본 에이전트를 사용하려면 이를 생략하세요.

## 문제 해결

### “자격증명을 찾을 수 없습니다”

Anthropic 토큰 프로필이 누락된 경우 다음을 실행하세요. `claude setup-token` 에
**게이트웨이 호스트**을 선택한 후 다시 확인하세요.

```bash
openclaw models status
```

### 토큰 만료/만료됨

달리다 `openclaw models status` 어떤 프로필이 만료되는지 확인하세요. 프로필의 경우
누락되었습니다. 재실행하세요. `claude setup-token` 토큰을 다시 붙여넣으세요.

## 요구사항

- Claude Max 또는 Pro 구독( `claude setup-token`)
- 클로드 코드 CLI 설치(`claude` 명령 가능)
