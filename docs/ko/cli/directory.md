---
read_when:
    - 채널의 연락처/그룹/본인 ID를 조회하고 싶습니다.
    - 채널 디렉터리 어댑터를 개발 중입니다.
summary: '`openclaw directory`에 대한 CLI 참조(자체, 동료, 그룹)'
title: 예배 규칙서
x-i18n:
    generated_at: "2026-02-08T15:50:51Z"
    model: gtx
    provider: google-translate
    source_hash: 7c878d9013aeaa22c8a21563fac30b465a86be85d8c917c5d4591b5c3d4b2025
    source_path: cli/directory.md
    workflow: 15
---

# `openclaw directory`

이를 지원하는 채널(연락처/동료, 그룹 및 "나")에 대한 디렉터리 조회입니다.

## 공통 플래그

- `--channel <name>`: 채널 ID/별칭(여러 채널이 구성된 경우 필수, 하나만 구성된 경우 자동)
- `--account <id>`: 계정 ID (기본값: 채널 기본값)
- `--json`: JSON 출력

## 메모

- `directory` 다른 명령에 붙여 넣을 수 있는 ID를 찾는 데 도움이 됩니다(특히 `openclaw message send --target ...`).
- 많은 채널의 경우 결과는 라이브 공급자 디렉터리가 아닌 구성 지원(허용 목록/구성된 그룹)입니다.
- 기본 출력은 `id` (그리고 가끔 `name`) 탭으로 구분됩니다. 사용 `--json` 스크립팅을 위해.

## 결과 사용 `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 형식(채널별)

- 왓츠앱: `+15551234567` (DM), `1234567890-1234567890@g.us` (그룹)
- 전보: `@username` 또는 숫자로 된 채팅 ID; 그룹은 숫자 ID입니다.
- 느슨하게: `user:U…` 그리고 `channel:C…`
- 불화: `user:<id>` 그리고 `channel:<id>`
- 매트릭스(플러그인): `user:@user:server`, `room:!roomId:server`, 또는 `#alias:server`
- Microsoft 팀(플러그인): `user:<id>` 그리고 `conversation:<id>`
- Zalo(플러그인): 사용자 ID(Bot API)
- 잘로 개인 / `zalouser` (플러그인): 스레드 ID(DM/그룹) `zca` (`me`, `friend list`, `group list`)

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

## 여러 떼

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
