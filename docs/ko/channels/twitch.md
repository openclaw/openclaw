---
summary: "Twitch 채팅 봇 구성 및 설정"
read_when:
  - OpenClaw 를 위한 Twitch 채팅 통합 설정 시
title: "Twitch"
---

# Twitch (플러그인)

IRC 연결을 통한 Twitch 채팅 지원입니다. OpenClaw 는 Twitch 사용자 (봇 계정) 로 연결하여 채널에서 메시지를 수신하고 전송합니다.

## 필요한 플러그인

Twitch 는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

CLI 를 통해 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/twitch
```

로컬 체크아웃 (git 리포지토리에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/twitch
```

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. 봇을 위한 전용 Twitch 계정을 생성합니다 (또는 기존 계정을 사용합니다).
2. 자격 증명을 생성합니다: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** 을 선택합니다
   - 범위 `chat:read` 및 `chat:write` 이 선택되어 있는지 확인합니다
   - **Client ID** 와 **Access Token** 을 복사합니다
3. Twitch 사용자 ID 를 찾습니다: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 토큰을 구성합니다:
   - 환경 변수: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (기본 계정 전용)
   - 또는 설정: `channels.twitch.accessToken`
   - 둘 다 설정된 경우 설정이 우선합니다 (환경 변수 폴백은 기본 계정 전용).
5. Gateway(게이트웨이) 를 시작합니다.

**⚠️ 중요:** 무단 사용자가 봇을 트리거하는 것을 방지하기 위해 접근 제어 (`allowFrom` 또는 `allowedRoles`) 를 추가하십시오. `requireMention` 의 기본값은 `true` 입니다.

최소 설정:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## 무엇인가요

- Gateway(게이트웨이) 가 소유하는 Twitch 채널입니다.
- 결정적 라우팅: 응답은 항상 Twitch 로 돌아갑니다.
- 각 계정은 격리된 세션 키 `agent:<agentId>:twitch:<accountName>` 에 매핑됩니다.
- `username` 는 봇의 계정 (인증 주체) 이며, `channel` 는 참여할 채팅방입니다.

## 설정 (자세히)

### 자격 증명 생성

[Twitch Token Generator](https://twitchtokengenerator.com/) 를 사용합니다:

- **Bot Token** 을 선택합니다
- 범위 `chat:read` 및 `chat:write` 이 선택되어 있는지 확인합니다
- **Client ID** 와 **Access Token** 을 복사합니다

수동 앱 등록은 필요하지 않습니다. 토큰은 몇 시간 후 만료됩니다.

### 봇 구성

**환경 변수 (기본 계정 전용):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**또는 설정:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

환경 변수와 설정이 모두 있는 경우 설정이 우선합니다.

### 접근 제어 (권장)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

강력한 허용 목록을 위해 `allowFrom` 를 권장합니다. 역할 기반 접근을 원한다면 대신 `allowedRoles` 를 사용하십시오.

**사용 가능한 역할:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**왜 사용자 ID 인가요?** 사용자 이름은 변경될 수 있어 사칭이 가능합니다. 사용자 ID 는 영구적입니다.

Twitch 사용자 ID 찾기: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Twitch 사용자 이름을 ID 로 변환)

## 토큰 갱신 (선택 사항)

[Twitch Token Generator](https://twitchtokengenerator.com/) 의 토큰은 자동으로 갱신할 수 없습니다.

자동 토큰 갱신을 위해 [Twitch Developer Console](https://dev.twitch.tv/console) 에서 자체 Twitch 애플리케이션을 생성하고 설정에 추가하십시오:

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

봇은 만료 전에 자동으로 토큰을 갱신하고 갱신 이벤트를 로그에 기록합니다.

## 다중 계정 지원

계정별 토큰으로 `channels.twitch.accounts` 를 사용하십시오. 공통 패턴은 [`gateway/configuration`](/gateway/configuration) 를 참조하십시오.

예시 (하나의 봇 계정이 두 개의 채널에 참여):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**참고:** 각 계정에는 자체 토큰이 필요합니다 (채널당 토큰 1개).

## 접근 제어

### 역할 기반 제한

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### 사용자 ID 허용 목록 (가장 안전)

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

`allowFrom` 는 하드 허용 목록입니다. 설정된 경우 해당 사용자 ID 만 허용됩니다.
역할 기반 접근을 원한다면 `allowFrom` 를 설정하지 않고 대신 `allowedRoles` 을 구성하십시오:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @멘션 요구 사항 비활성화

기본적으로 `requireMention` 는 `true` 입니다. 비활성화하고 모든 메시지에 응답하려면 다음을 사용하십시오:

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

먼저 진단 명령을 실행하십시오:

```bash
openclaw doctor
openclaw channels status --probe
```

### 봇이 메시지에 응답하지 않음

**접근 제어 확인:** 사용자 ID 가 `allowFrom` 에 포함되어 있는지 확인하거나, 테스트를 위해
`allowFrom` 를 일시적으로 제거하고 `allowedRoles: ["all"]` 를 설정하십시오.

**봇이 채널에 있는지 확인:** 봇은 `channel` 에 지정된 채널에 참여해야 합니다.

### 토큰 문제

**"Failed to connect" 또는 인증 오류:**

- `accessToken` 이 OAuth 액세스 토큰 값인지 확인하십시오 (일반적으로 `oauth:` 접두사로 시작)
- 토큰에 `chat:read` 및 `chat:write` 범위가 있는지 확인하십시오
- 토큰 갱신을 사용하는 경우 `clientSecret` 및 `refreshToken` 가 설정되어 있는지 확인하십시오

### 토큰 갱신이 작동하지 않음

**갱신 이벤트에 대한 로그를 확인하십시오:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

"token refresh disabled (no refresh token)" 이 표시되면:

- `clientSecret` 이 제공되었는지 확인하십시오
- `refreshToken` 이 제공되었는지 확인하십시오

## 설정

**계정 설정:**

- `username` - 봇 사용자 이름
- `accessToken` - `chat:read` 및 `chat:write` 을 포함한 OAuth 액세스 토큰
- `clientId` - Twitch Client ID (Token Generator 또는 자체 앱에서 획득)
- `channel` - 참여할 채널 (필수)
- `enabled` - 이 계정 활성화 (기본값: `true`)
- `clientSecret` - 선택 사항: 자동 토큰 갱신용
- `refreshToken` - 선택 사항: 자동 토큰 갱신용
- `expiresIn` - 토큰 만료 시간 (초)
- `obtainmentTimestamp` - 토큰 획득 타임스탬프
- `allowFrom` - 사용자 ID 허용 목록
- `allowedRoles` - 역할 기반 접근 제어 (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @멘션 요구 (기본값: `true`)

**프로바이더 옵션:**

- `channels.twitch.enabled` - 채널 시작 활성화/비활성화
- `channels.twitch.username` - 봇 사용자 이름 (단일 계정 간소화 설정)
- `channels.twitch.accessToken` - OAuth 액세스 토큰 (단일 계정 간소화 설정)
- `channels.twitch.clientId` - Twitch Client ID (단일 계정 간소화 설정)
- `channels.twitch.channel` - 참여할 채널 (단일 계정 간소화 설정)
- `channels.twitch.accounts.<accountName>` - 다중 계정 설정 (위의 모든 계정 필드)

전체 예시:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## 도구 작업

에이전트는 다음 작업으로 `twitch` 를 호출할 수 있습니다:

- `send` - 채널로 메시지 전송

예시:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## 보안 및 운영

- **토큰을 비밀번호처럼 취급하십시오** - 토큰을 git 에 커밋하지 마십시오
- **장기 실행 봇에는 자동 토큰 갱신을 사용하십시오**
- **접근 제어에는 사용자 이름 대신 사용자 ID 허용 목록을 사용하십시오**
- **토큰 갱신 이벤트와 연결 상태를 위해 로그를 모니터링하십시오**
- **토큰 범위를 최소화하십시오** - `chat:read` 및 `chat:write` 만 요청하십시오
- **문제가 지속되면**: 다른 프로세스가 세션을 소유하지 않는 것을 확인한 후 Gateway(게이트웨이) 를 재시작하십시오

## 제한 사항

- 메시지당 **500자** (단어 경계에서 자동 분할)
- 분할 전에 Markdown 이 제거됩니다
- 속도 제한 없음 (Twitch 의 내장 속도 제한 사용)
