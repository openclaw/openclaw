---
summary: "CLI reference for `openclaw directory` (self, peers, groups)"
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
title: "directory"
x-i18n:
  source_hash: 7c878d9013aeaa22c8a21563fac30b465a86be85d8c917c5d4591b5c3d4b2025
---

# `openclaw directory`

이를 지원하는 채널(연락처/동료, 그룹 및 "나")에 대한 디렉터리 조회입니다.

## 공통 플래그

- `--channel <name>`: 채널 ID/별칭(여러 채널이 구성된 경우 필수, 하나만 구성된 경우 자동)
- `--account <id>` : 계정ID (기본값 : 채널기본값)
- `--json`: JSON 출력

## 메모

- `directory`는 다른 명령(특히 `openclaw message send --target ...`)에 붙여넣을 수 있는 ID를 찾는 데 도움이 됩니다.
- 많은 채널의 경우 결과는 라이브 공급자 디렉터리가 아닌 구성 지원(허용 목록/구성된 그룹)입니다.
- 기본 출력은 탭으로 구분된 `id`(경우에 따라 `name`)입니다. 스크립팅에는 `--json`를 사용하세요.

## `message send`로 결과 사용

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식(채널별)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (그룹)
- 텔레그램: `@username` 또는 숫자로 된 채팅 ID; 그룹은 숫자 ID입니다.
- 슬랙: `user:U…` 및 `channel:C…`
- 불일치: `user:<id>` 및 `channel:<id>`
- 매트릭스(플러그인): `user:@user:server`, `room:!roomId:server` 또는 `#alias:server`
- Microsoft Teams(플러그인): `user:<id>` 및 `conversation:<id>`
- Zalo(플러그인): 사용자 ID(Bot API)
- Zalo Personal / `zalouser` (플러그인): `zca` (`me`, `friend list`, `group list`)의 스레드 ID(DM/그룹)

## 자기(“나”)

```bash
openclaw directory self --channel zalouser
```

## 피어(연락처/사용자)

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
