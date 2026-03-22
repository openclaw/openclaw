---
summary: "NIP-04 암호화 메시지를 통한 Nostr DM 채널"
read_when:
  - OpenClaw 가 Nostr 를 통해 DM 을 수신하도록 하려는 경우
  - 분산형 메시징을 설정하는 경우
title: "Nostr"
x-i18n:
  source_path: docs/channels/nostr.md
---

# Nostr

**상태:** 선택적 플러그인 (기본적으로 비활성화).

Nostr 는 소셜 네트워킹을 위한 분산형 프로토콜입니다. 이 채널을 통해 OpenClaw 는 NIP-04 를 통한 암호화된 다이렉트 메시지 (DM) 를 수신하고 응답할 수 있습니다.

## 설치 (필요 시)

### 온보딩 (권장)

- 온보딩 (`openclaw onboard`) 및 `openclaw channels add` 에서 선택적 채널 플러그인을 나열합니다.
- Nostr 를 선택하면 필요 시 플러그인 설치를 안내합니다.

설치 기본값:

- **Dev 채널 + git checkout 가능:** 로컬 플러그인 경로를 사용합니다.
- **Stable/Beta:** npm 에서 다운로드합니다.

프롬프트에서 항상 선택을 재정의할 수 있습니다.

### 수동 설치

```bash
openclaw plugins install @openclaw/nostr
```

로컬 checkout 사용 (개발 워크플로):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

플러그인을 설치하거나 활성화한 후 Gateway 를 재시작하세요.

### 비대화형 설정

```bash
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY" --relay-urls "wss://relay.damus.io,wss://relay.primal.net"
```

`--use-env` 를 사용하면 키를 구성에 저장하는 대신 `NOSTR_PRIVATE_KEY` 를 환경에 유지합니다.

## 빠른 설정

1. Nostr 키페어 생성 (필요한 경우):

```bash
# nak 사용
nak key generate
```

2. 구성에 추가:

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
    },
  },
}
```

3. 키 내보내기:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway 를 재시작합니다.

## 구성 참조

| 키           | 타입     | 기본값                                      | 설명                           |
| ------------ | -------- | ------------------------------------------- | ------------------------------ |
| `privateKey` | string   | 필수                                        | `nsec` 또는 hex 형식의 개인 키 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 릴레이 URL (WebSocket)         |
| `dmPolicy`   | string   | `pairing`                                   | DM 접근 정책                   |
| `allowFrom`  | string[] | `[]`                                        | 허용된 발신자 공개 키          |
| `enabled`    | boolean  | `true`                                      | 채널 활성화/비활성화           |
| `name`       | string   | -                                           | 표시 이름                      |
| `profile`    | object   | -                                           | NIP-01 프로필 메타데이터       |

## 프로필 메타데이터

프로필 데이터는 NIP-01 `kind:0` 이벤트로 게시됩니다. Control UI (Channels -> Nostr -> Profile) 에서 관리하거나 구성에서 직접 설정할 수 있습니다.

예시:

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      profile: {
        name: "openclaw",
        displayName: "OpenClaw",
        about: "Personal assistant DM bot",
        picture: "https://example.com/avatar.png",
        banner: "https://example.com/banner.png",
        website: "https://example.com",
        nip05: "openclaw@example.com",
        lud16: "openclaw@example.com",
      },
    },
  },
}
```

참고 사항:

- 프로필 URL 은 `https://` 를 사용해야 합니다.
- 릴레이에서 가져오기는 필드를 병합하고 로컬 재정의를 보존합니다.

## 접근 제어

### DM 정책

- **pairing** (기본값): 알 수 없는 발신자에게 페어링 코드를 제공합니다.
- **allowlist**: `allowFrom` 의 공개 키만 DM 을 보낼 수 있습니다.
- **open**: 공개 인바운드 DM (`allowFrom: ["*"]` 필요).
- **disabled**: 인바운드 DM 을 무시합니다.

### 허용 목록 예시

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      dmPolicy: "allowlist",
      allowFrom: ["npub1abc...", "npub1xyz..."],
    },
  },
}
```

## 키 형식

허용되는 형식:

- **개인 키:** `nsec...` 또는 64 자 hex
- **공개 키 (`allowFrom`):** `npub...` 또는 hex

## 릴레이

기본값: `relay.damus.io` 및 `nos.lol`.

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"],
    },
  },
}
```

팁:

- 이중화를 위해 2-3 개 릴레이를 사용하세요.
- 너무 많은 릴레이를 피하세요 (지연, 중복).
- 유료 릴레이로 안정성을 향상시킬 수 있습니다.
- 로컬 릴레이는 테스트에 적합합니다 (`ws://localhost:7777`).

## 프로토콜 지원

| NIP    | 상태   | 설명                                 |
| ------ | ------ | ------------------------------------ |
| NIP-01 | 지원됨 | 기본 이벤트 형식 + 프로필 메타데이터 |
| NIP-04 | 지원됨 | 암호화된 DM (`kind:4`)               |
| NIP-17 | 계획됨 | Gift-wrapped DM                      |
| NIP-44 | 계획됨 | 버전화된 암호화                      |

## 테스트

### 로컬 릴레이

```bash
# strfry 시작
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["ws://localhost:7777"],
    },
  },
}
```

### 수동 테스트

1. 로그에서 봇 공개 키 (npub) 를 확인합니다.
2. Nostr 클라이언트를 엽니다 (Damus, Amethyst 등).
3. 봇 공개 키로 DM 을 보냅니다.
4. 응답을 확인합니다.

## 문제 해결

### 메시지를 수신하지 못함

- 개인 키가 유효한지 확인합니다.
- 릴레이 URL 이 도달 가능하고 `wss://` (또는 로컬의 경우 `ws://`) 를 사용하는지 확인합니다.
- `enabled` 가 `false` 가 아닌지 확인합니다.
- Gateway 로그에서 릴레이 연결 오류를 확인합니다.

### 응답을 보내지 못함

- 릴레이가 쓰기를 수락하는지 확인합니다.
- 아웃바운드 연결성을 확인합니다.
- 릴레이 속도 제한을 주시합니다.

### 중복 응답

- 여러 릴레이를 사용할 때 예상됩니다.
- 메시지는 이벤트 ID 로 중복 제거됩니다. 첫 번째 전달만 응답을 트리거합니다.

## 보안

- 개인 키를 커밋하지 마세요.
- 키에는 환경 변수를 사용하세요.
- 프로덕션 봇에는 `allowlist` 를 고려하세요.

## 제한 사항 (MVP)

- 다이렉트 메시지만 (그룹 채팅 없음).
- 미디어 첨부 파일 없음.
- NIP-04 만 (NIP-17 gift-wrap 계획됨).
