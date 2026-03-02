---
summary: "채널에 대한 CLI 참조 (자신, 피어, 그룹)"
read_when:
  - 채널의 연락처/그룹/자신 ID 를 찾으려고 할 때
  - 채널 디렉토리 어댑터를 개발 중일 때
title: "directory"
---

# `openclaw directory`

지원하는 채널에 대한 디렉토리 조회 (연락처/피어, 그룹 및 "me").

## 일반 플래그

- `--channel <name>`: 채널 id/별칭 (여러 채널이 구성된 경우 필수; 하나만 구성된 경우 자동).
- `--account <id>`: 계정 id (기본값: 채널 기본값).
- `--json`: JSON 출력.

## 참고

- `directory` 는 다른 명령에 붙여넣을 수 있는 ID 를 찾는 데 도움이 됩니다 (특히 `openclaw message send --target ...`).
- 많은 채널의 경우 결과는 구성 기반 (허용 목록/구성된 그룹) 이며 라이브 제공자 디렉토리가 아닙니다.
- 기본 출력은 탭으로 구분된 `id` (그리고 때때로 `name`) 입니다. 스크립팅을 위해 `--json` 을 사용합니다.

## `message send` 와 함께 결과 사용

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식 (채널별)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` 또는 숫자 chat id; 그룹은 숫자 ID
- Slack: `user:U…` 및 `channel:C…`
- Discord: `user:<id>` 및 `channel:<id>`
- Matrix (플러그인): `user:@user:server`, `room:!roomId:server` 또는 `#alias:server`
- Microsoft Teams (플러그인): `user:<id>` 및 `conversation:<id>`
- Zalo (플러그인): 사용자 id (Bot API)
- Zalo Personal / `zalouser` (플러그인): `zca` 에서 스레드 id (DM/group) (`me`, `friend list`, `group list`)

## 자신 ("me")

```bash
openclaw directory self --channel zalouser
```

## 피어 (연락처/사용자)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## 그룹

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/directory.md
workflow: 15
