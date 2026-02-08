---
read_when:
    - OpenClaw가 Nostr을 통해 DM을 받기를 원합니다.
    - 분산 메시징을 설정 중입니다.
summary: NIP-04 암호화된 메시지를 통한 Nostr DM 채널
title: 노스트르
x-i18n:
    generated_at: "2026-02-08T15:49:58Z"
    model: gtx
    provider: google-translate
    source_hash: 6b9fe4c74bf5e7c0f59bbaa129ec5270fd29a248551a8a9a7dde6cff8fb46111
    source_path: channels/nostr.md
    workflow: 15
---

# 노스트르

**상태:** 선택적 플러그인(기본적으로 비활성화되어 있음)

Nostr은 소셜 네트워킹을 위한 분산형 프로토콜입니다. 이 채널을 통해 OpenClaw는 NIP-04를 통해 암호화된 직접 메시지(DM)를 수신하고 응답할 수 있습니다.

## 설치(요청 시)

### 온보딩(권장)

- 온보딩 마법사(`openclaw onboard`) 그리고 `openclaw channels add` 선택적 채널 플러그인을 나열합니다.
- Nostr을 선택하면 요청 시 플러그인을 설치하라는 메시지가 표시됩니다.

기본값 설치:

- **개발자 채널 + Git 체크아웃 가능:** 로컬 플러그인 경로를 사용합니다.
- **안정/베타:** npm에서 다운로드합니다.

언제든지 프롬프트의 선택 사항을 무시할 수 있습니다.

### 수동 설치

```bash
openclaw plugins install @openclaw/nostr
```

로컬 결제 사용(개발 워크플로):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

플러그인을 설치하거나 활성화한 후 게이트웨이를 다시 시작하십시오.

## 빠른 설정

1. Nostr 키 쌍을 생성합니다(필요한 경우):

```bash
# Using nak
nak key generate
```

2. 구성에 추가:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. 키를 내보냅니다.

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 게이트웨이를 다시 시작하십시오.

## 구성 참조

| Key          | Type     | Default                                     | Description                         |
| ------------ | -------- | ------------------------------------------- | ----------------------------------- |
| `privateKey` | string   | required                                    | Private key in `nsec` or hex format |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URLs (WebSocket)              |
| `dmPolicy`   | string   | `pairing`                                   | DM access policy                    |
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys              |
| `enabled`    | boolean  | `true`                                      | Enable/disable channel              |
| `name`       | string   | -                                           | Display name                        |
| `profile`    | object   | -                                           | NIP-01 profile metadata             |

## 프로필 메타데이터

프로필 데이터는 NIP-01로 게시됩니다. `kind:0` 이벤트. Control UI(Channels -> Nostr -> Profile)에서 관리하거나 구성에서 직접 설정할 수 있습니다.

예:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

참고:

- 프로필 URL은 다음을 사용해야 합니다. `https://`.
- 릴레이에서 가져오면 필드가 병합되고 로컬 재정의가 유지됩니다.

## 접근 통제

### DM 정책

- **편성** (기본값): 알 수 없는 발신자가 페어링 코드를 받습니다.
- **허용 목록**: 공개키만 있음 `allowFrom` DM해도 돼.
- **열려 있는**: 공개 인바운드 DM(필수 `allowFrom: ["*"]`).
- **장애가 있는**: 인바운드 DM을 무시합니다.

### 허용 목록 예

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## 주요 형식

허용되는 형식:

- **개인 키:** `nsec...` 또는 64자 16진수
- **공개키(`allowFrom`):** `npub...` 또는 16진수

## 릴레이

기본값: `relay.damus.io` 그리고 `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

팁:

- 이중화를 위해 2-3개의 릴레이를 사용하십시오.
- 너무 많은 릴레이(대기 시간, 중복)를 피하세요.
- 유료 릴레이는 신뢰성을 향상시킬 수 있습니다.
- 로컬 릴레이는 테스트에 적합합니다(`ws://localhost:7777`).

## 프로토콜 지원

| NIP    | Status    | Description                           |
| ------ | --------- | ------------------------------------- |
| NIP-01 | Supported | Basic event format + profile metadata |
| NIP-04 | Supported | Encrypted DMs (`kind:4`)              |
| NIP-17 | Planned   | Gift-wrapped DMs                      |
| NIP-44 | Planned   | Versioned encryption                  |

## 테스트

### 로컬 릴레이

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### 수동 테스트

1. 로그에서 봇 pubkey(npub)를 기록해 둡니다.
2. Nostr 클라이언트(Damus, Amethyst 등)를 엽니다.
3. 봇 공개키를 DM으로 보내주세요.
4. 응답을 확인합니다.

## 문제 해결

### 메시지를 받지 못함

- 개인 키가 유효한지 확인하세요.
- 릴레이 URL에 접근할 수 있는지 확인하고 사용하세요. `wss://` (또는 `ws://` 지역용).
- 확인하다 `enabled` 아니다 `false`.
- 릴레이 연결 오류에 대해서는 게이트웨이 로그를 확인하세요.

### 응답을 보내지 않음

- 릴레이가 쓰기를 허용하는지 확인하세요.
- 아웃바운드 연결을 확인합니다.
- 릴레이 속도 제한을 확인하세요.

### 중복된 응답

- 다중 릴레이를 사용할 때 예상됩니다.
- 메시지는 이벤트 ID별로 중복 제거됩니다. 첫 번째 전달만 응답을 트리거합니다.

## 보안

- 개인 키를 커밋하지 마십시오.
- 키에는 환경 변수를 사용하십시오.
- 고려하다 `allowlist` 생산 봇용.

## 제한사항(MVP)

- 직접 메시지만 가능합니다(그룹 채팅 불가).
- 미디어 첨부 파일이 없습니다.
- NIP-04만 해당(NIP-17 선물 포장 예정).
