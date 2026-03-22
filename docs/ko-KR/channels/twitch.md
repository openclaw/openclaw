---
summary: "Twitch 채팅 봇 구성 및 설정"
read_when:
  - OpenClaw 용 Twitch 채팅 통합을 설정하는 경우
title: "Twitch"
x-i18n:
  source_path: docs/channels/twitch.md
---

# Twitch (플러그인)

IRC 연결을 통한 Twitch 채팅 지원. OpenClaw 는 Twitch 사용자 (봇 계정) 로 연결하여 채널에서 메시지를 수신하고 전송합니다.

## 플러그인 필요

Twitch 는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

CLI 를 통한 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/twitch
```

로컬 checkout (git 저장소에서 실행할 때):

```bash
openclaw plugins install ./extensions/twitch
```

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. 봇 전용 Twitch 계정을 만듭니다 (또는 기존 계정 사용).
2. 자격 증명 생성: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** 선택
   - `chat:read` 와 `chat:write` 스코프가 선택되어 있는지 확인
   - **Client ID** 와 **Access Token** 복사
3. Twitch 사용자 ID 찾기: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 토큰 구성:
   - 환경: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (기본 계정만)
   - 또는 구성: `channels.twitch.accessToken`
   - 둘 다 설정된 경우 구성이 우선합니다 (환경 폴백은 기본 계정만).
5. Gateway 를 시작합니다.

**주의:** 권한 없는 사용자가 봇을 트리거하는 것을 방지하기 위해 접근 제어 (`allowFrom` 또는 `allowedRoles`) 를 추가하세요. `requireMention` 은 기본적으로 `true` 입니다.

최소 구성:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 봇의 Twitch 계정
      accessToken: "oauth:abc123...", // OAuth Access Token (또는 OPENCLAW_TWITCH_ACCESS_TOKEN 환경 변수 사용)
      clientId: "xyz789...", // Token Generator 의 Client ID
      channel: "vevisk", // 참여할 Twitch 채널 채팅 (필수)
      allowFrom: ["123456789"], // (권장) 자신의 Twitch 사용자 ID 만
    },
  },
}
```

## 이것이 무엇인가

- Gateway 가 소유하는 Twitch 채널.
- 결정적 라우팅: 응답은 항상 Twitch 로 돌아갑니다.
- 각 계정은 격리된 세션 키 `agent:<agentId>:twitch:<accountName>` 에 매핑됩니다.
- `username` 은 봇의 계정 (인증하는 사람), `channel` 은 참여할 채팅방입니다.

## 토큰 갱신 (선택)

[Twitch Token Generator](https://twitchtokengenerator.com/) 의 토큰은 자동 갱신이 불가능합니다 - 만료되면 재생성하세요.

자동 토큰 갱신을 위해 [Twitch Developer Console](https://dev.twitch.tv/console) 에서 자체 Twitch 애플리케이션을 만들고 구성에 추가합니다:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

봇이 만료 전에 자동으로 토큰을 갱신하고 갱신 이벤트를 로깅합니다.

## 다중 계정 지원

계정별 토큰으로 `channels.twitch.accounts` 를 사용합니다. 공유 패턴은 [`gateway/configuration`](/gateway/configuration) 을 참조하세요.

## 접근 제어

### 사용자 ID 로 허용 목록 (가장 안전)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### 역할 기반 접근 (대안)

`allowFrom` 은 하드 허용 목록입니다. 역할 기반 접근을 원하면 `allowFrom` 을 설정하지 않고 대신 `allowedRoles` 를 구성합니다.

**사용 가능한 역할:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**왜 사용자 ID 인가?** 사용자명은 변경될 수 있어 사칭이 가능합니다. 사용자 ID 는 영구적입니다.

### @멘션 요구 사항 비활성화

기본적으로 `requireMention` 은 `true` 입니다. 비활성화하고 모든 메시지에 응답하려면:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## 문제 해결

먼저 진단 명령을 실행합니다:

```bash
openclaw doctor
openclaw channels status --probe
```

### 봇이 메시지에 응답하지 않음

**접근 제어 확인:** 사용자 ID 가 `allowFrom` 에 있는지 확인하거나, 테스트를 위해 일시적으로 `allowFrom` 을 제거하고 `allowedRoles: ["all"]` 을 설정합니다.

### 토큰 문제

- `accessToken` 이 OAuth 액세스 토큰 값인지 확인 (일반적으로 `oauth:` 접두사로 시작)
- 토큰에 `chat:read` 와 `chat:write` 스코프가 있는지 확인
- 토큰 갱신을 사용하는 경우 `clientSecret` 과 `refreshToken` 이 설정되어 있는지 확인

## 제한 사항

- 메시지당 **500 자** (단어 경계에서 자동 청크)
- Markdown 은 청킹 전에 제거됩니다
- 속도 제한 없음 (Twitch 의 내장 속도 제한 사용)
