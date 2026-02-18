````markdown
---
summary: "NIP-04 암호화 메시지를 통한 Nostr 다이렉트 메시지 채널"
read_when:
  - OpenClaw가 Nostr를 통해 다이렉트 메시지를 수신하도록 하려는 경우
  - 탈중앙화 메시징 설정 중인 경우
title: "Nostr"
---

# Nostr

**상태:** 선택적 플러그인 (기본적으로 비활성화됨).

Nostr는 소셜 네트워킹을 위한 탈중앙화 프로토콜입니다. 이 채널은 OpenClaw가 NIP-04를 통해 암호화된 다이렉트 메시지 (DM)를 수신하고 응답할 수 있도록 합니다.

## 설치 (요청 시)

### 온보딩 (추천)

- 온보딩 마법사 (`openclaw onboard`) 및 `openclaw channels add`는 선택적 채널 플러그인을 나열합니다.
- Nostr를 선택하면, 요청 시 플러그인을 설치하도록 안내합니다.

설치 기본값:

- **개발자 채널 + 사용 가능한 Git 체크아웃:** 로컬 플러그인 경로를 사용합니다.
- **안정적/베타:** npm에서 다운로드합니다.

언제든지 프롬프트에서 선택을 무시할 수 있습니다.

### 수동 설치

```bash
openclaw plugins install @openclaw/nostr
```
````

로컬 체크아웃 사용 (개발 워크플로우):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

플러그인을 설치하거나 활성화한 후 게이트웨이를 재시작하세요.

## 빠른 설정

1. Nostr 키 쌍을 생성합니다 (필요한 경우):

```bash
# nak 사용
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

4. 게이트웨이를 재시작합니다.

## 구성 참조

| 키           | 유형     | 기본값                                      | 설명                              |
| ------------ | -------- | ------------------------------------------- | --------------------------------- |
| `privateKey` | string   | 필수                                        | `nsec` 또는 16진수 형식의 개인 키 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 릴레이 URL (WebSocket)            |
| `dmPolicy`   | string   | `pairing`                                   | DM 접근 정책                      |
| `allowFrom`  | string[] | `[]`                                        | 허용된 발신자 공개 키             |
| `enabled`    | boolean  | `true`                                      | 채널 활성화/비활성화              |
| `name`       | string   | -                                           | 표시 이름                         |
| `profile`    | object   | -                                           | NIP-01 프로필 메타데이터          |

## 프로필 메타데이터

프로필 데이터는 NIP-01 `kind:0` 이벤트로 게시됩니다. 제어 UI(Channels -> Nostr -> Profile)에서 관리하거나 설정에 직접 설정할 수 있습니다.

예시:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "개인 비서 DM 봇",
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

참고 사항:

- 프로필 URL은 `https://`를 사용해야 합니다.
- 릴레이에서 가져온 경우 필드를 병합하고 로컬 오버라이드를 유지합니다.

## 접근 제어

### DM 정책

- **pairing** (기본값): 알려지지 않은 발신자는 페어링 코드를 받습니다.
- **allowlist**: `allowFrom`에 있는 공개 키만 DM을 보낼 수 있습니다.
- **open**: 공개 수신 다이렉트 메시지 (`allowFrom: ["*"]` 필요).
- **disabled**: 수신 다이렉트 메시지를 무시합니다.

### 화이트리스트 예시

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

허용된 형식:

- **개인 키:** `nsec...` 또는 64자 16진수
- **공개 키 (`allowFrom`):** `npub...` 또는 16진수

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

- 중복 방지를 위해 2-3개의 릴레이를 사용하세요.
- 너무 많은 릴레이를 피하세요 (지연, 중복 발생 가능성).
- 유료 릴레이는 안정성을 개선할 수 있습니다.
- 테스트용으로는 로컬 릴레이를 사용해도 좋습니다 (`ws://localhost:7777`).

## 프로토콜 지원

| NIP    | 상태    | 설명                                 |
| ------ | ------- | ------------------------------------ |
| NIP-01 | 지원됨  | 기본 이벤트 형식 + 프로필 메타데이터 |
| NIP-04 | 지원됨  | 암호화된 다이렉트 메시지 (`kind:4`)  |
| NIP-17 | 계획 중 | 포장된 다이렉트 메시지               |
| NIP-44 | 계획 중 | 버전이 지정된 암호화                 |

## 테스트

### 로컬 릴레이

```bash
# strfry 시작
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

1. 로그에서 봇의 공개 키 (npub)를 기록해 둡니다.
2. Nostr 클라이언트 (Damus, Amethyst 등)를 엽니다.
3. 봇의 공개 키로 다이렉트 메시지를 보냅니다.
4. 응답을 확인합니다.

## 문제 해결

### 메시지를 받지 못함

- 개인 키가 유효한지 확인합니다.
- 릴레이 URL이 도달 가능한지 확인하고 `wss://` (또는 로컬의 경우 `ws://`)를 사용합니다.
- `enabled`가 `false`가 아닌지 확인합니다.
- 게이트웨이 로그에서 릴레이 연결 오류를 확인합니다.

### 응답을 보내지 않음

- 릴레이가 쓰기를 허용하는지 확인합니다.
- 아웃바운드 연결성이 유효한지 검토합니다.
- 릴레이 속도 제한을 주시하세요.

### 응답 중복

- 여러 릴레이를 사용할 때 예상되는 상황입니다.
- 메시지는 이벤트 ID에 의해 중복 방지됩니다. 첫 번째 전달만 응답을 트리거합니다.

## 보안

- 절대로 개인 키를 커밋하지 마세요.
- 키는 환경 변수를 사용하세요.
- 프로덕션 봇에는 `allowlist`를 고려하세요.

## 제한 (MVP)

- 다이렉트 메시지만 가능 (그룹 채팅 불가).
- 미디어 첨부 파일 없음.
- NIP-04만 지원 (NIP-17 포장 계획 중).

```

```
