---
summary: "Model authentication: OAuth, API keys, and setup-token"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
title: "Authentication"
x-i18n:
  source_hash: 66fa2c64ff374c9cfcdb4e7a951b0d164d512295e65513eb682f12191b75e557
---

# 인증

OpenClaw는 모델 공급자를 위한 OAuth 및 API 키를 지원합니다. 인류를 위한
계정의 경우 **API 키**를 사용하는 것이 좋습니다. Claude 구독 액세스의 경우,
`claude setup-token`에서 생성된 수명이 긴 토큰을 사용하세요.

전체 OAuth 흐름 및 저장소는 [/concepts/oauth](/concepts/oauth)를 참조하세요.
레이아웃.

## 권장 인류학 설정(API 키)

Anthropic을 직접 사용하는 경우 API 키를 사용하세요.

1. Anthropic 콘솔에서 API 키를 생성합니다.
2. **게이트웨이 호스트**(`openclaw gateway`를 실행하는 머신)에 배치합니다.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 게이트웨이가 systemd/launchd에서 실행되는 경우 키를
   `~/.openclaw/.env` 데몬이 읽을 수 있도록 합니다.

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

환경 상속(`env.shellEnv`에 대한 자세한 내용은 [도움말](/help)을 참조하세요.
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: 설정 토큰(구독 인증)

Anthropic의 경우 권장 경로는 **API 키**입니다. 클로드를 사용하는 경우
구독을 사용하는 경우 설정 토큰 흐름도 지원됩니다. **게이트웨이 호스트**에서 실행하세요.

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
이 자격 증명은 Claude Code에서만 사용할 수 있으며 다른 API 요청에는 사용할 수 없습니다.
```

...대신 Anthropic API 키를 사용하세요.

수동 토큰 입력(모든 공급자, `auth-profiles.json` 쓰기 + 구성 업데이트):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

자동화 친화적인 확인(만료/누락 시 `1` 종료, 만료 시 `2` 종료):

```bash
openclaw models status --check
```

선택적 ops 스크립트(systemd/Termux)는 여기에 설명되어 있습니다.
[/자동화/인증 모니터링](/automation/auth-monitoring)

> `claude setup-token`에는 대화형 TTY가 필요합니다.

## 모델 인증 상태 확인 중

```bash
openclaw models status
openclaw doctor
```

## 어떤 자격 증명이 사용되는지 제어

### 세션별(채팅 명령)

`/model <alias-or-id>@<profileId>`를 사용하여 현재 세션에 대한 특정 공급자 자격 증명을 고정합니다(예: 프로필 ID: `anthropic:default`, `anthropic:work`).

컴팩트 선택기에는 `/model`(또는 `/model list`)를 사용하세요. 전체 보기를 보려면 `/model status`를 사용하세요(후보자 + 다음 인증 프로필, 구성 시 공급자 엔드포인트 세부 정보 포함).

### 에이전트별(CLI 재정의)

에이전트에 대한 명시적 인증 프로필 순서 재정의를 설정합니다(해당 에이전트의 `auth-profiles.json`에 저장됨).

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 타겟팅하려면 `--agent <id>`를 사용하세요. 구성된 기본 에이전트를 사용하려면 이를 생략하세요.

## 문제 해결

### “자격증명을 찾을 수 없습니다.”

Anthropic 토큰 프로필이 누락된 경우 `claude setup-token`를 실행하세요.
**게이트웨이 호스트**를 확인한 후 다시 확인하세요.

```bash
openclaw models status
```

### 토큰 만료/만료됨

`openclaw models status`를 실행하여 만료되는 프로필을 확인하세요. 프로필의 경우
누락된 경우 `claude setup-token`를 다시 실행하고 토큰을 다시 붙여넣으세요.

## 요구사항

- Claude Max 또는 Pro 구독(`claude setup-token`용)
- Claude Code CLI 설치 (`claude` 명령어 사용 가능)
