---
summary: "`openclaw devices`에 대한 CLI 참조 (디바이스 페어링 + 토큰 로테이션/폐기)"
read_when:
  - 디바이스 페어링 요청을 승인할 때
  - 디바이스 토큰을 로테이션하거나 폐기해야 할 때
title: "디바이스"
---

# `openclaw devices`

디바이스 페어링 요청과 디바이스 범위 토큰을 관리합니다.

## Commands

### `openclaw devices list`

대기 중인 페어링 요청과 페어링된 디바이스를 나열합니다.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

대기 중인 디바이스 페어링 요청을 승인합니다.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

대기 중인 디바이스 페어링 요청을 거부합니다.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

특정 역할에 대한 디바이스 토큰을 로테이션합니다 (선택적으로 스코프 업데이트).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

특정 역할에 대한 디바이스 토큰을 폐기합니다.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway(게이트웨이) WebSocket URL (구성된 경우 기본값은 `gateway.remote.url`).
- `--token <token>`: Gateway(게이트웨이) 토큰 (필요한 경우).
- `--password <password>`: Gateway(게이트웨이) 비밀번호 (비밀번호 인증).
- `--timeout <ms>`: RPC 타임아웃.
- `--json`: JSON 출력 (스크립팅에 권장).

참고: `--url`를 설정하면, CLI 는 구성 또는 환경 변수 자격 증명으로 대체하지 않습니다.
`--token` 또는 `--password`를 명시적으로 전달하십시오. 명시적 자격 증명이 누락되면 오류입니다.

## Notes

- 토큰 로테이션은 새 토큰(민감 정보)을 반환합니다. 비밀로 취급하십시오.
- 이러한 명령에는 `operator.pairing` (또는 `operator.admin`) 스코프가 필요합니다.
