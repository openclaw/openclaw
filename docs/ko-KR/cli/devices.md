---
summary: "CLI reference for `openclaw devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "devices"
---

# `openclaw devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `openclaw devices list`

List pending pairing requests and paired devices.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve [requestId] [--latest]`

대기 중인 디바이스 페어링 요청을 승인합니다. `requestId`가 생략되면 OpenClaw는
가장 최근의 대기 요청을 자동으로 승인합니다.

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

Reject a pending device pairing request.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON 출력 (스크립팅에 권장).

참고: `--url`을 설정할 때, CLI는 구성이나 환경 변수 인증을 대체하지 않습니다.
`--token` 또는 `--password`를 명시적으로 전달하세요. 명시적 인증이 누락되면 오류가 발생합니다.

## Notes

- 토큰 로테이션은 새 토큰을 반환합니다 (민감한 정보). 비밀처럼 다루세요.
- 이러한 명령어는 `operator.pairing` (또는 `operator.admin`) 범위가 필요합니다.