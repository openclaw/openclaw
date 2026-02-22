---
summary: "`openclaw channels` CLI 참조 (계정, 상태, 로그인/로그아웃, 로그)"
read_when:
  - 채널 계정 추가/제거를 원할 때 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage)
  - 채널 상태를 확인하거나 채널 로그를 확인하고 싶을 때
title: "채널"
---

# `openclaw channels`

게이트웨이에서 채팅 채널 계정과 그들의 런타임 상태를 관리합니다.

관련 문서:

- 채널 안내서: [채널](/channels/index)
- 게이트웨이 구성: [구성](/gateway/configuration)

## 일반 명령어

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
openclaw channels remove --channel telegram --delete
```

팁: `openclaw channels add --help`는 채널 별 플래그 (토큰, 앱 토큰, signal-cli 경로 등)을 보여줍니다.

## 로그인 / 로그아웃 (대화형)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 문제 해결

- 전반적인 탐색을 위해 `openclaw status --deep`을 실행하세요.
- 안내된 수정 방법을 위해 `openclaw doctor`를 사용하세요.
- `openclaw channels list`는 `Claude: HTTP 403 ... user:profile`을 출력합니다 → 사용 스냅샷에는 `user:profile` 스코프가 필요합니다. `--no-usage`를 사용하거나, claude.ai 세션 키 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`)를 제공하거나, Claude Code CLI를 통해 다시 인증하세요.

## 기능 탐색

프로바이더 기능 힌트(도메인/스코프 가능 시) 및 정적 기능 지원을 가져옵니다:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

주의:

- `--channel`은 선택 사항이며, 생략하면 모든 채널(확장 포함)을 나열합니다.
- `--target`은 `channel:<id>` 또는 숫자로만 된 채널 id를 받아들이며, Discord에만 적용됩니다.
- 탐색은 프로바이더 별로 다릅니다: Discord는 도메인 + 선택적 채널 권한을 갖고; Slack은 봇 + 사용자 스코프를 갖고; Telegram은 봇 플래그 + 웹훅; Signal은 데몬 버전; MS Teams는 앱 토큰 + Graph 역할/스코프(알려진 범위에 주석 처리)를 갖습니다. 탐색이 불가능한 채널은 `탐색: 사용 불가`를 보고합니다.

## 이름을 ID로 변환

프로바이더 디렉토리를 사용하여 채널/사용자 이름을 ID로 변환합니다:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

주의:

- `--kind user|group|auto`를 사용하여 대상 유형을 강제로 지정하세요.
- 여러 항목이 같은 이름을 공유할 경우 매칭된 활성 항목을 우선합니다.
