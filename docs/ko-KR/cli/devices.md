---
summary: "장치 페어링 + 토큰 순환/취소를 위한 CLI 참조"
read_when:
  - 장치 페어링 요청을 승인할 때
  - 장치 토큰을 순환 또는 취소해야 할 때
title: "devices"
---

# `openclaw devices`

장치 페어링 요청 및 장치 범위의 토큰을 관리합니다.

## 명령

### `openclaw devices list`

대기 중인 페어링 요청 및 페어링된 장치를 나열합니다.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices remove <deviceId>`

한 개의 페어링된 장치 항목을 제거합니다.

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

페어링된 장치를 일괄 정리합니다.

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

대기 중인 장치 페어링 요청을 승인합니다. `requestId` 를 생략하면 OpenClaw 는 가장 최근의 대기 중인 요청을 자동으로 승인합니다.

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

대기 중인 장치 페어링 요청을 거부합니다.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

특정 역할에 대한 장치 토큰을 순환시킵니다 (선택적으로 범위 업데이트).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

특정 역할에 대한 장치 토큰을 취소합니다.

```
openclaw devices revoke --device <deviceId> --role node
```

## 일반 옵션

- `--url <url>`: Gateway WebSocket URL (기본값: `gateway.remote.url` 구성됨).
- `--token <token>`: Gateway 토큰 (필요한 경우).
- `--password <password>`: Gateway 비밀번호 (비밀번호 인증).
- `--timeout <ms>`: RPC 시간 제한.
- `--json`: JSON 출력 (스크립팅 권장).

참고: `--url` 을 설정하면 CLI 는 구성 또는 환경 자격 증명으로 폴백하지 않습니다.
명시적으로 `--token` 또는 `--password` 를 전달합니다. 명시적 자격 증명이 없으면 오류입니다.

## 참고

- 토큰 순환은 새 토큰을 반환합니다 (민감). 비밀처럼 취급합니다.
- 이러한 명령에는 `operator.pairing` (또는 `operator.admin`) 범위가 필요합니다.
- `devices clear` 는 의도적으로 `--yes` 로 게이트됩니다.
- 로컬 loopback 에서 페어링 범위를 사용할 수 없고 명시적 `--url` 를 전달하지 않으면, 목록/승인이 로컬 페어링 폴백을 사용할 수 있습니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/devices.md
workflow: 15
