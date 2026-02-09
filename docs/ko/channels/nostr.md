---
summary: "NIP-04 암호화 메시지를 통한 Nostr 다이렉트 메시지 채널"
read_when:
  - OpenClaw 가 Nostr 를 통해 다이렉트 메시지를 수신하도록 하려는 경우
  - 탈중앙화 메시징을 설정하는 경우
title: "Nostr"
---

# Nostr

**상태:** 선택적 플러그인 (기본적으로 비활성화됨).

Nostr 는 소셜 네트워킹을 위한 탈중앙화 프로토콜입니다. 이 채널은 NIP-04 를 통해 암호화된 다이렉트 메시지 (DMs) 를 수신하고 응답하도록 OpenClaw 를 활성화합니다.

## 설치 (온디맨드)

### Onboarding (recommended)

- 온보딩 마법사 (`openclaw onboard`) 및 `openclaw channels add` 에서 선택적 채널 플러그인이 나열됩니다.
- Nostr 를 선택하면 온디맨드로 플러그인 설치를 안내합니다.

기본 설치 동작:

- **Dev 채널 + git 체크아웃 사용 가능:** 로컬 플러그인 경로를 사용합니다.
- **Stable/Beta:** npm 에서 다운로드합니다.

프롬프트에서 언제든지 선택을 재정의할 수 있습니다.

### 수동 설치

```bash
openclaw plugins install @openclaw/nostr
```

로컬 체크아웃 사용 (개발 워크플로):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

플러그인을 설치하거나 활성화한 후 Gateway 를 재시작하십시오.

## 빠른 설정

1. Nostr 키페어를 생성합니다 (필요한 경우):

```bash
# Using nak
nak key generate
```

2. 설정에 추가합니다:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. 키를 내보냅니다:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway 를 재시작합니다.

## 구성 참조

| 키            | 유형                                                           | 기본값                                         | 설명                                     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------- |
| `privateKey` | string                                                       | required                                    | `nsec` 또는 hex 형식의 개인 키                 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 릴레이 URL (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM 접근 정책                               |
| `allowFrom`  | string[] | `[]`                                        | 허용된 발신자 공개 키                           |
| `enabled`    | boolean                                                      | `true`                                      | 채널 활성화/비활성화                            |
| `name`       | string                                                       | -                                           | 표시 이름                                  |
| `profile`    | object                                                       | -                                           | NIP-01 프로필 메타데이터                       |

## 프로필 메타데이터

프로필 데이터는 NIP-01 `kind:0` 이벤트로 게시됩니다. Control UI (채널 -> Nostr -> 프로필) 에서 관리하거나 설정에서 직접 지정할 수 있습니다.

예시:

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

- 프로필 URL 은 `https://` 를 사용해야 합니다.
- 릴레이에서 가져오면 필드가 병합되며 로컬 재정의는 유지됩니다.

## 접근 제어

### DM 정책

- **pairing** (기본값): 알 수 없는 발신자는 페어링 코드를 받습니다.
- **allowlist**: `allowFrom` 에 있는 공개 키만 DM 을 보낼 수 있습니다.
- **open**: 공개 인바운드 DM ( `allowFrom: ["*"]` 필요).
- **disabled**: 인바운드 DM 을 무시합니다.

### Allowlist 예시

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

## 키 형식

허용되는 형식:

- **개인 키:** `nsec...` 또는 64자 hex
- **공개 키 (`allowFrom`):** `npub...` 또는 hex

## 릴레이

기본값: `relay.damus.io` 및 `nos.lol`.

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

Tips:

- 중복 대비를 위해 2-3 개의 릴레이를 사용하십시오.
- 릴레이를 과도하게 사용하지 마십시오 (지연, 중복).
- 유료 릴레이는 신뢰성을 개선할 수 있습니다.
- 로컬 릴레이는 테스트에 적합합니다 (`ws://localhost:7777`).

## 프로토콜 지원

| NIP    | 상태  | 설명                                    |
| ------ | --- | ------------------------------------- |
| NIP-01 | 지원됨 | 기본 이벤트 형식 + 프로필 메타데이터                 |
| NIP-04 | 지원됨 | 암호화된 DM (`kind:4`) |
| NIP-17 | 계획됨 | 기프트 래핑된 DM                            |
| NIP-44 | 계획됨 | 버전 관리 암호화                             |

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

1. 로그에서 봇 공개 키 (npub) 를 확인합니다.
2. Nostr 클라이언트 (Damus, Amethyst 등) 를 엽니다.
3. DM the bot pubkey.
4. 응답을 확인합니다.

## 문제 해결

### 메시지를 수신하지 못하는 경우

- 개인 키가 유효한지 확인하십시오.
- 릴레이 URL 에 접근 가능하며 `wss://` (또는 로컬의 경우 `ws://`) 를 사용하는지 확인하십시오.
- `enabled` 이 `false` 가 아닌지 확인하십시오.
- 릴레이 연결 오류가 있는지 Gateway 로그를 확인하십시오.

### 응답을 보내지 못하는 경우

- 릴레이가 쓰기를 허용하는지 확인하십시오.
- 아웃바운드 연결성을 확인하십시오.
- 릴레이 속도 제한을 확인하십시오.

### 중복 응답

- 여러 릴레이를 사용하는 경우 예상되는 동작입니다.
- 메시지는 이벤트 ID 로 중복 제거되며, 최초 전달만 응답을 트리거합니다.

## 보안

- 개인 키를 절대 커밋하지 마십시오.
- 키에는 환경 변수를 사용하십시오.
- 프로덕션 봇에는 `allowlist` 사용을 고려하십시오.

## 제한 사항 (MVP)

- 다이렉트 메시지만 지원합니다 (그룹 채팅 미지원).
- 미디어 첨부를 지원하지 않습니다.
- NIP-04 만 지원합니다 (NIP-17 기프트 래핑은 계획됨).
