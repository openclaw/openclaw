---
summary: "`openclaw channels` CLI 레퍼런스 (계정, 상태, 로그인/로그아웃, 로그)"
read_when:
  - 채널 계정을 추가/제거하고 싶을 때 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage)
  - 채널 상태를 확인하거나 채널 로그를 테일링하고 싶을 때
title: "channels"
x-i18n:
  source_path: "docs/cli/channels.md"
---

# `openclaw channels`

채팅 채널 계정과 Gateway에서의 런타임 상태를 관리합니다.

관련 문서:

- 채널 가이드: [Channels](/channels/index)
- Gateway 설정: [Configuration](/gateway/configuration)

## 주요 명령어

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 계정 추가 / 제거

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels remove --channel telegram --delete
```

팁: `openclaw channels add --help`는 채널별 플래그를 표시합니다 (토큰, 개인 키, 앱 토큰, signal-cli 경로 등).

플래그 없이 `openclaw channels add`를 실행하면, 대화형 마법사가 다음을 프롬프트할 수 있습니다:

- 선택된 채널별 계정 id
- 해당 계정의 선택적 표시 이름
- `Bind configured channel accounts to agents now?`

지금 바인딩을 확인하면, 마법사가 각 설정된 채널 계정을 어떤 에이전트가 소유해야 하는지 묻고 계정 범위의 라우팅 바인딩을 작성합니다.

나중에 `openclaw agents bindings`, `openclaw agents bind`, `openclaw agents unbind`로 동일한 라우팅 규칙을 관리할 수도 있습니다 ([agents](/cli/agents) 참조).

단일 계정 최상위 설정을 사용하는 채널에 기본이 아닌 계정을 추가하면 (`channels.<channel>.accounts` 항목이 아직 없는 경우), OpenClaw는 계정 범위의 단일 계정 최상위 값을 `channels.<channel>.accounts.default`로 이동한 다음 새 계정을 작성합니다. 이렇게 하면 다중 계정 형태로 전환하면서 원래 계정 동작을 유지합니다.

라우팅 동작은 일관되게 유지됩니다:

- 기존 채널 전용 바인딩 (`accountId` 없음)은 기본 계정과 계속 매치됩니다.
- `channels add`는 비대화형 모드에서 바인딩을 자동 생성하거나 다시 작성하지 않습니다.
- 대화형 설정에서는 선택적으로 계정 범위의 바인딩을 추가할 수 있습니다.

설정이 이미 혼합 상태인 경우 (이름이 지정된 계정이 존재하고, `default`가 누락되었으며, 최상위 단일 계정 값이 여전히 설정된 경우), `openclaw doctor --fix`를 실행하여 계정 범위 값을 `accounts.default`로 이동하세요.

## 로그인 / 로그아웃 (대화형)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 문제 해결

- `openclaw status --deep`을 실행하여 광범위한 프로브를 수행하세요.
- 안내형 수정에는 `openclaw doctor`를 사용하세요.
- `openclaw channels list`가 `Claude: HTTP 403 ... user:profile`을 출력하면 사용량 스냅샷에 `user:profile` 스코프가 필요합니다. `--no-usage`를 사용하거나, claude.ai 세션 키 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`)를 제공하거나, Claude Code CLI를 통해 다시 인증하세요.
- `openclaw channels status`는 Gateway에 접근할 수 없을 때 설정 전용 요약으로 폴백합니다. 지원되는 채널 자격 증명이 SecretRef를 통해 설정되었지만 현재 명령 경로에서 사용할 수 없는 경우, 해당 계정을 설정되지 않음으로 표시하는 대신 저하된 노트와 함께 설정됨으로 보고합니다.

## 기능 프로브

프로바이더 기능 힌트 (사용 가능한 경우 인텐트/스코프)와 정적 기능 지원을 가져옵니다:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

참고:

- `--channel`은 선택 사항입니다. 생략하면 모든 채널 (확장 포함)을 나열합니다.
- `--target`은 `channel:<id>` 또는 원시 숫자 채널 id를 받으며 Discord에만 적용됩니다.
- 프로브는 프로바이더별로 다릅니다: Discord 인텐트 + 선택적 채널 권한; Slack 봇 + 사용자 스코프; Telegram 봇 플래그 + 웹훅; Signal 데몬 버전; Microsoft Teams 앱 토큰 + Graph 역할/스코프 (알려진 경우 주석 포함). 프로브가 없는 채널은 `Probe: unavailable`을 보고합니다.

## 이름을 ID로 변환

프로바이더 디렉터리를 사용하여 채널/사용자 이름을 ID로 변환합니다:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

참고:

- `--kind user|group|auto`를 사용하여 대상 유형을 강제할 수 있습니다.
- 여러 항목이 동일한 이름을 공유하는 경우 활성 매치를 우선합니다.
- `channels resolve`는 읽기 전용입니다. 선택된 계정이 SecretRef를 통해 설정되었지만 해당 자격 증명을 현재 명령 경로에서 사용할 수 없는 경우, 전체 실행을 중단하는 대신 노트와 함께 저하된 미해석 결과를 반환합니다.
