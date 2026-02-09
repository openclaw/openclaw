---
summary: "`openclaw channels`에 대한 CLI 레퍼런스 (계정, 상태, 로그인/로그아웃, 로그)"
read_when:
  - WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage 채널 계정을 추가/제거하려는 경우
  - 채널 상태를 확인하거나 채널 로그를 테일링하려는 경우
title: "channels"
---

# `openclaw channels`

Gateway(게이트웨이)에서 채팅 채널 계정과 해당 런타임 상태를 관리합니다.

관련 문서:

- 채널 가이드: [Channels](/channels/index)
- Gateway(게이트웨이) 구성: [Configuration](/gateway/configuration)

## 공통 명령

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

팁: `openclaw channels add --help` 는 채널별 플래그 (토큰, 앱 토큰, signal-cli 경로 등)를 표시합니다.

## 로그인 / 로그아웃 (대화형)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 문제 해결

- 광범위한 프로브를 위해 `openclaw status --deep` 를 실행합니다.
- 안내형 수정 사항을 위해 `openclaw doctor` 를 사용합니다.
- `openclaw channels list` 는 `Claude: HTTP 403 ... user:profile` 를 출력합니다 → 사용 현황 스냅샷에는 `user:profile` 스코프가 필요합니다. `--no-usage` 를 사용하거나, claude.ai 세션 키 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`) 를 제공하거나, Claude Code CLI 를 통해 다시 인증하십시오.

## 기능 프로브

가능한 경우 프로바이더 기능 힌트 (intents/scopes)와 정적 기능 지원을 가져옵니다:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

참고:

- `--channel` 는 선택 사항입니다. 이를 생략하면 모든 채널 (확장 포함)을 나열합니다.
- `--target` 는 `channel:<id>` 또는 원시 숫자 채널 id 를 허용하며 Discord 에만 적용됩니다.
- 프로브는 프로바이더별로 다릅니다: Discord intents + 선택적 채널 권한; Slack 봇 + 사용자 스코프; Telegram 봇 플래그 + 웹훅; Signal 데몬 버전; MS Teams 앱 토큰 + Graph 역할/스코프 (알려진 경우 주석 포함). 프로브가 없는 채널은 `Probe: unavailable` 를 보고합니다.

## 이름을 ID 로 해석

프로바이더 디렉토리를 사용하여 채널/사용자 이름을 ID 로 해석합니다:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

참고:

- 대상 유형을 강제하려면 `--kind user|group|auto` 를 사용하십시오.
- 동일한 이름을 공유하는 여러 항목이 있는 경우, 활성 일치를 우선하여 해석합니다.
