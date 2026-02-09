---
summary: " `openclaw directory` 에 대한 CLI 참조 (self, peers, groups)"
read_when:
  - 채널에 사용할 연락처 / 그룹 / self ID 를 조회하려는 경우
  - 채널 디렉토리 어댑터를 개발하는 경우
title: "디렉터리"
---

# `openclaw directory`

이를 지원하는 채널에 대한 디렉터리 조회 (연락처 / peers, 그룹, 그리고 'me').

## 공통 플래그

- `--channel <name>`: 채널 id / 별칭 (여러 채널이 구성된 경우 필수; 하나만 구성된 경우 자동)
- `--account <id>`: 계정 id (기본값: 채널 기본값)
- `--json`: JSON 출력

## 참고 사항

- `directory` 는 다른 명령에 붙여 넣을 수 있는 ID 를 찾는 데 도움을 주기 위한 것입니다 (특히 `openclaw message send --target ...`).
- 많은 채널에서 결과는 라이브 프로바이더 디렉터리가 아니라 구성 기반 (허용 목록 / 구성된 그룹) 입니다.
- 기본 출력은 탭으로 구분된 `id` (그리고 때로는 `name`) 이며, 스크립팅에는 `--json` 를 사용하십시오.

## `message send` 와 함께 결과 사용하기

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식 (채널별)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (그룹)
- Telegram: `@username` 또는 숫자 채팅 id; 그룹은 숫자 id 입니다
- Slack: `user:U…` 및 `channel:C…`
- Discord: `user:<id>` 및 `channel:<id>`
- Matrix (플러그인): `user:@user:server`, `room:!roomId:server`, 또는 `#alias:server`
- Microsoft Teams (플러그인): `user:<id>` 및 `conversation:<id>`
- Zalo (플러그인): 사용자 id (Bot API)
- Zalo Personal / `zalouser` (플러그인): `zca` 에서의 스레드 id (DM / 그룹) (`me`, `friend list`, `group list`)

## Self ('me')

```bash
openclaw directory self --channel zalouser
```

## Peers (연락처 / 사용자)

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
