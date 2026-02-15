---
summary: "Nostr DM channel via NIP-04 encrypted messages"
read_when:
  - You want OpenClaw to receive DMs via Nostr
  - You're setting up decentralized messaging
title: "Nostr"
x-i18n:
  source_hash: 6b9fe4c74bf5e7c0f59bbaa129ec5270fd29a248551a8a9a7dde6cff8fb46111
---

# Nostr

**상태:** 선택적 플러그인(기본적으로 비활성화되어 있음)

Nostr은 소셜 네트워킹을 위한 분산형 프로토콜입니다. 이 채널을 통해 OpenClaw는 NIP-04를 통해 암호화된 직접 메시지(DM)를 수신하고 응답할 수 있습니다.

## 설치(요청 시)

### 온보딩(권장)

- 온보딩 마법사(`openclaw onboard`) 및 `openclaw channels add`에는 선택적 채널 플러그인이 나열되어 있습니다.
- Nostr을 선택하면 요청 시 플러그인을 설치하라는 메시지가 표시됩니다.

기본값 설치:

- **개발자 채널 + git 체크아웃 가능:** 로컬 플러그인 경로를 사용합니다.
- **안정적/베타:** npm에서 다운로드합니다.

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

3. 키 내보내기:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 게이트웨이를 다시 시작합니다.

## 구성 참조

| 열쇠         | 유형     | 기본값                                      | 설명                              |
| ------------ | -------- | ------------------------------------------- | --------------------------------- |
| `privateKey` | 문자열   | 필수                                        | `nsec` 또는 16진수 형식의 개인 키 |
| `relays`     | 문자열[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 릴레이 URL(WebSocket)             |
| `dmPolicy`   | 문자열   | `pairing`                                   | DM 접근 정책                      |
| `allowFrom`  | 문자열[] | `[]`                                        | 허용된 발신자 공개키              |
| `enabled`    | 부울     | `true`                                      | 채널 활성화/비활성화              |
| `name`       | 문자열   | -                                           | 표시 이름                         |
| `profile`    | 개체     | -                                           | NIP-01 프로필 메타데이터          |

## 프로필 메타데이터

프로필 데이터는 NIP-01 `kind:0` 이벤트로 게시됩니다. Control UI(Channels -> Nostr -> Profile)에서 관리하거나 구성에서 직접 설정할 수 있습니다.

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

- 프로필 URL은 `https://`를 사용해야 합니다.
- 릴레이에서 가져오면 필드가 병합되고 로컬 재정의가 유지됩니다.

## 접근 제어

### DM 정책

- **페어링**(기본값): 알 수 없는 발신자가 페어링 코드를 받습니다.
- **허용 목록**: `allowFrom`에 있는 공개키만 DM을 보낼 수 있습니다.
- **공개**: 공개 인바운드 DM(`allowFrom: ["*"]` 필요).
- **비활성화됨**: 인바운드 DM을 무시합니다.

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

## 키 형식

허용되는 형식:

- **개인 키:** `nsec...` 또는 64자 16진수
- **Pubkeys (`allowFrom`):** `npub...` 또는 16진수

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

팁:

- 이중화를 위해 2~3개의 릴레이를 사용합니다.
- 너무 많은 릴레이(지연, 중복)를 피하세요.
- 유료 릴레이를 사용하면 신뢰성을 높일 수 있습니다.
- 로컬 릴레이는 테스트하기에 적합합니다(`ws://localhost:7777`).

## 프로토콜 지원

| 닙     | 상태    | 설명                                 |
| ------ | ------- | ------------------------------------ |
| NIP-01 | 지원됨  | 기본 이벤트 형식 + 프로필 메타데이터 |
| NIP-04 | 지원됨  | 암호화된 DM(`kind:4`)                |
| NIP-17 | Planned | 선물 포장된 DM                       |
| NIP-44 | 예정    | 버전이 지정된 암호화                 |

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

1. 로그에서 봇 공개 키(npub)를 기록해 둡니다.
2. Nostr 클라이언트(Damus, Amethyst 등)를 엽니다.
3. 봇 공개키를 DM으로 보내주세요.
4. 응답을 확인합니다.

## 문제 해결

### 메시지를 받지 못함

- 개인 키가 유효한지 확인하십시오.
- 릴레이 URL에 연결할 수 있는지 확인하고 `wss://`(또는 로컬의 경우 `ws://`)를 사용합니다.
- `enabled`가 `false`가 아닌지 확인하세요.
- 게이트웨이 로그에서 릴레이 연결 오류를 확인하세요.

### 응답을 보내지 않음

- 릴레이가 쓰기를 허용하는지 확인하세요.
- 아웃바운드 연결을 확인합니다.
- 릴레이 속도 제한을 확인하세요.

### 중복 응답

- 다중 릴레이를 사용할 때 예상됩니다.
- 메시지는 이벤트 ID별로 중복 제거됩니다. 첫 번째 전달만 응답을 트리거합니다.

## 보안

- 절대 개인 키를 커밋하지 마세요.
- 키에 환경 변수를 사용합니다.
- 프로덕션 봇의 경우 `allowlist`를 고려하세요.

## 제한 사항(MVP)

- 다이렉트 메시지만 가능합니다(그룹 채팅 불가).
- 미디어 첨부가 없습니다.
- NIP-04만 해당(NIP-17 선물 포장 예정).
