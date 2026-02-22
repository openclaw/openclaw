---
summary: "`openclaw directory` (자신, 연락처, 그룹)에 대한 CLI 참조"
read_when:
  - 채널에 대한 연락처/그룹/자신의 ID를 조회하고 싶을 때
  - 채널 디렉토리 어댑터를 개발 중일 때
title: "디렉토리"
---

# `openclaw directory`

지원되는 채널(연락처/피어, 그룹, 그리고 "자신")을 위한 디렉토리 조회.

## 공통 플래그

- `--channel <name>`: 채널 id/별칭 (여러 채널이 구성된 경우 필수; 하나만 구성된 경우 자동)
- `--account <id>`: 계정 id (기본값: 채널 기본값)
- `--json`: JSON 출력

## 참고 사항

- `directory`는 다른 명령어 (특히 `openclaw message send --target ...`)에 붙여넣을 수 있는 ID를 찾는 데 도움을 줍니다.
- 많은 채널에서 결과는 라이브 프로바이더 디렉토리보다는 설정 기반 (허용 목록 / 구성된 그룹)입니다.
- 기본 출력은 탭으로 구분된 `id` (및 때때로 `name`)입니다; 스크립팅용으로는 `--json`을 사용하세요.

## `message send`와 결과 사용하기

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식 (채널별)

- WhatsApp: `+15551234567` (다이렉트 메시지), `1234567890-1234567890@g.us` (그룹)
- Telegram: `@username` 또는 숫자 채팅 id; 그룹은 숫자 id
- Slack: `user:U…` 및 `channel:C…`
- Discord: `user:<id>` 및 `channel:<id>`
- Matrix (플러그인): `user:@user:server`, `room:!roomId:server`, 또는 `#alias:server`
- Microsoft Teams (플러그인): `user:<id>` 및 `conversation:<id>`
- Zalo (플러그인): 사용자 id (Bot API)
- Zalo Personal / `zalouser` (플러그인): `zca` (`me`, `friend list`, `group list`)에서 가져온 스레드 id (다이렉트 메시지/그룹)

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
