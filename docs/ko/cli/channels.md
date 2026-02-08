---
read_when:
    - 채널 계정(WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost(플러그인)/Signal/iMessage)을 추가/제거하고 싶습니다.
    - 채널 상태 또는 테일 채널 로그를 확인하고 싶습니다.
summary: '`openclaw channels`에 대한 CLI 참조(계정, 상태, 로그인/로그아웃, 로그)'
title: 채널
x-i18n:
    generated_at: "2026-02-08T15:52:30Z"
    model: gtx
    provider: google-translate
    source_hash: 16ab1642f247bfa96e8e08dfeb1eedfccb148f40d91099f5423f971df2b54e20
    source_path: cli/channels.md
    workflow: 15
---

# `openclaw channels`

게이트웨이에서 채팅 채널 계정과 해당 런타임 상태를 관리합니다.

관련 문서:

- 채널 가이드: [채널](/channels/index)
- 게이트웨이 구성: [구성](/gateway/configuration)

## 일반적인 명령

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 계정 추가/제거

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

팁: `openclaw channels add --help` 채널별 플래그(토큰, 앱 토큰, signal-cli 경로 등)를 표시합니다.

## 로그인/로그아웃(대화형)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 문제 해결

- 달리다 `openclaw status --deep` 광범위한 조사를 위해.
- 사용 `openclaw doctor` 안내 수정을 위해.
- `openclaw channels list` 인쇄물 `Claude: HTTP 403 ... user:profile` → 사용량 스냅샷이 필요합니다. `user:profile` 범위. 사용 `--no-usage`, 또는 clude.ai 세션 키(`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`) 또는 Claude Code CLI를 통해 다시 인증하세요.

## 기능 프로브

가져오기 공급자 기능 힌트(사용 가능한 경우 의도/범위)와 정적 기능 지원:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

참고:

- `--channel` 선택 사항입니다. 모든 채널(확장 프로그램 포함)을 나열하려면 이를 생략하세요.
- `--target` 받아들인다 `channel:<id>` 또는 원시 숫자 채널 ID이며 Discord에만 적용됩니다.
- 프로브는 공급자별로 다릅니다. Discord 의도 + 선택적 채널 권한; Slack 봇 + 사용자 범위; 텔레그램 봇 플래그 + 웹훅; 신호 데몬 버전; MS Teams 앱 토큰 + 그래프 역할/범위(알려진 경우 주석 처리). 프로브 보고서가 없는 채널 `Probe: unavailable`.

## 이름을 ID로 확인

공급자 디렉터리를 사용하여 채널/사용자 이름을 ID로 확인합니다.

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

참고:

- 사용 `--kind user|group|auto` 대상 유형을 강제로 적용합니다.
- 여러 항목이 동일한 이름을 공유하는 경우 해결 방법은 활성 일치를 선호합니다.
