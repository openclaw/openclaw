---
read_when:
    - 장치 페어링 요청을 승인하고 있습니다.
    - 기기 토큰을 순환하거나 취소해야 합니다.
summary: '`openclaw devices`에 대한 CLI 참조(장치 페어링 + 토큰 순환/해지)'
title: 장치
x-i18n:
    generated_at: "2026-02-08T15:47:44Z"
    model: gtx
    provider: google-translate
    source_hash: ac7d130ecdc5d4296019529dca33145b9f359a36bc9498262f6eb04ba43ec845
    source_path: cli/devices.md
    workflow: 15
---

# `openclaw devices`

장치 페어링 요청 및 장치 범위 토큰을 관리합니다.

## 명령

### `openclaw devices list`

보류 중인 페어링 요청 및 페어링된 장치를 나열합니다.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

보류 중인 장치 페어링 요청을 승인합니다.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

보류 중인 장치 페어링 요청을 거부합니다.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

특정 역할에 대한 장치 토큰을 순환합니다(선택적으로 범위 업데이트).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

특정 역할에 대한 장치 토큰을 취소합니다.

```
openclaw devices revoke --device <deviceId> --role node
```

## 공통 옵션

- `--url <url>`: 게이트웨이 WebSocket URL(기본값: `gateway.remote.url` 구성된 경우).
- `--token <token>`: 게이트웨이 토큰(필요한 경우).
- `--password <password>`: 게이트웨이 비밀번호(비밀번호 인증)입니다.
- `--timeout <ms>`: RPC 시간 초과.
- `--json`: JSON 출력(스크립팅에 권장됨).

참고: 설정할 때 `--url`, CLI는 구성 또는 환경 자격 증명으로 대체되지 않습니다.
통과하다 `--token` 또는 `--password` 명시적으로. 명시적 자격 증명이 누락되면 오류가 발생합니다.

## 메모

- 토큰 순환은 새 토큰(민감함)을 반환합니다. 비밀처럼 다루세요.
- 이 명령에는 다음이 필요합니다. `operator.pairing` (또는 `operator.admin`) 범위.
