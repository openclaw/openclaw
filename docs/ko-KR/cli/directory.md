---
summary: "`openclaw directory` CLI 레퍼런스 (self, peers, groups)"
read_when:
  - 채널의 연락처/그룹/자기 자신 ID를 조회하고 싶을 때
  - 채널 디렉터리 어댑터를 개발할 때
title: "directory"
x-i18n:
  source_path: "docs/cli/directory.md"
---

# `openclaw directory`

디렉터리 조회를 지원하는 채널 (연락처/피어, 그룹, "me")을 위한 디렉터리 조회입니다.

## 공통 플래그

- `--channel <name>`: 채널 id/별칭 (여러 채널이 설정된 경우 필수; 하나만 설정된 경우 자동)
- `--account <id>`: 계정 id (기본값: 채널 기본값)
- `--json`: JSON 출력

## 참고

- `directory`는 다른 명령에 붙여넣을 수 있는 ID를 찾는 데 도움을 주기 위한 것입니다 (특히 `openclaw message send --target ...`).
- 많은 채널에서 결과는 라이브 프로바이더 디렉터리가 아닌 설정 기반 (허용 목록 / 설정된 그룹)입니다.
- 기본 출력은 탭으로 구분된 `id` (때로는 `name` 포함)입니다. 스크립팅에는 `--json`을 사용하세요.

## `message send`와 함께 결과 사용

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식 (채널별)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (그룹)
- Telegram: `@username` 또는 숫자 chat id; 그룹은 숫자 id
- Slack: `user:U…`과 `channel:C…`
- Discord: `user:<id>`와 `channel:<id>`
- Matrix (플러그인): `user:@user:server`, `room:!roomId:server`, 또는 `#alias:server`
- Microsoft Teams (플러그인): `user:<id>`와 `conversation:<id>`
- Zalo (플러그인): user id (Bot API)
- Zalo Personal / `zalouser` (플러그인): `zca`의 thread id (DM/그룹) (`me`, `friend list`, `group list`)

## Self ("me")

```bash
openclaw directory self --channel zalouser
```

## Peers (연락처/사용자)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
