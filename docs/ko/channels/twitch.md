---
read_when:
    - OpenClaw용 Twitch 채팅 통합 설정
summary: Twitch 채팅 봇 구성 및 설정
title: 경련
x-i18n:
    generated_at: "2026-02-08T15:51:48Z"
    model: gtx
    provider: google-translate
    source_hash: 4fa7daa11d1e5ed43c9a8f9f7092809bf2c643838fc5b0c8df27449e430796dc
    source_path: channels/twitch.md
    workflow: 15
---

# 트위치(플러그인)

IRC 연결을 통한 Twitch 채팅 지원. OpenClaw는 Twitch 사용자(봇 계정)로 연결하여 채널에서 메시지를 주고받습니다.

## 플러그인 필요

Twitch는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/twitch
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/twitch
```

세부: [플러그인](/tools/plugin)

## 빠른 설정(초보자)

1. 봇 전용 Twitch 계정을 생성하세요(또는 기존 계정을 사용하세요).
2. 자격 증명을 생성합니다: [Twitch 토큰 생성기](https://twitchtokengenerator.com/)
   - 선택하다 **봇 토큰**
   - 범위 확인 `chat:read` 그리고 `chat:write` 선택되었습니다
   - 복사 **클라이언트 ID** 그리고 **액세스 토큰**
3. 귀하의 Twitch 사용자 ID를 찾으십시오: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 토큰을 구성합니다.
   - 환경: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (기본 계정만 해당)
   - 또는 구성: `channels.twitch.accessToken`
   - 둘 다 설정된 경우 구성이 우선 적용됩니다(환경 대체는 기본 계정에만 해당).
5. 게이트웨이를 시작하십시오.

**⚠️ 중요:** 액세스 제어 추가(`allowFrom` 또는 `allowedRoles`) 권한이 없는 사용자가 봇을 실행하는 것을 방지합니다. `requireMention` 기본값은 `true`.

최소 구성:

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

## 그것은 무엇입니까

- Gateway가 소유한 Twitch 채널입니다.
- 결정적 라우팅: 답변은 항상 Twitch로 돌아갑니다.
- 각 계정은 격리된 세션 키에 매핑됩니다. `agent:<agentId>:twitch:<accountName>`.
- `username` 봇의 계정(인증하는 사람)입니다. `channel` 어떤 채팅방에 참여할지입니다.

## 설정(상세)

### 자격 증명 생성

사용 [Twitch 토큰 생성기](https://twitchtokengenerator.com/):

- 선택하다 **봇 토큰**
- 범위 확인 `chat:read` 그리고 `chat:write` 선택되었습니다
- 복사 **클라이언트 ID** 그리고 **액세스 토큰**

수동 앱 등록이 필요하지 않습니다. 토큰은 몇 시간 후에 만료됩니다.

### 봇 구성

**Env var(기본 계정만 해당):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**또는 구성: **

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

env와 config가 모두 설정된 경우 config가 우선 적용됩니다.

### 액세스 제어(권장)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

선호하다 `allowFrom` 하드 허용 목록의 경우. 사용 `allowedRoles` 대신 역할 기반 액세스를 원하는 경우.

**사용 가능한 역할:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**왜 사용자 ID인가요?** 사용자 이름은 변경되어 가장이 허용될 수 있습니다. 사용자 ID는 영구적입니다.

귀하의 Twitch 사용자 ID를 찾으십시오: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Twitch 사용자 이름을 ID로 변환)

## 토큰 새로 고침(선택 ​​사항)

토큰 [Twitch 토큰 생성기](https://twitchtokengenerator.com/) 자동으로 새로 고칠 수 없습니다. 만료되면 다시 생성됩니다.

자동 토큰 새로고침을 위해서는 다음에서 자신만의 Twitch 애플리케이션을 만드세요. [트위치 개발자 콘솔](https://dev.twitch.tv/console) 구성에 추가하십시오.

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

봇은 만료되기 전에 자동으로 토큰을 새로 고치고 새로 고침 이벤트를 기록합니다.

## 다중 계정 지원

사용 `channels.twitch.accounts` 계정별 토큰으로. 보다 [`gateway/configuration`](/gateway/configuration) 공유 패턴의 경우.

예(두 채널에 하나의 봇 계정):

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

**메모:** 각 계정에는 자체 토큰이 필요합니다(채널당 토큰 1개).

## 접근 통제

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

### 사용자 ID별 허용 목록(가장 안전함)

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

### 역할 기반 액세스(대체)

`allowFrom` 하드 허용 목록입니다. 설정되면 해당 사용자 ID만 허용됩니다.
역할 기반 액세스를 원하면 떠나세요. `allowFrom` 설정 해제 및 구성 `allowedRoles` 대신에:

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

기본적으로 `requireMention` ~이다 `true`. 모든 메시지를 비활성화하고 응답하려면:

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

먼저 진단 명령을 실행합니다.

```bash
openclaw doctor
openclaw channels status --probe
```

### 봇이 메시지에 응답하지 않습니다.

**액세스 제어를 확인하세요.** 사용자 ID가 다음과 같은지 확인하세요. `allowFrom`, 또는 일시적으로 제거
`allowFrom` 그리고 설정 `allowedRoles: ["all"]` 테스트합니다.

**봇이 채널에 있는지 확인하세요.** 봇은 다음에 지정된 채널에 참여해야 합니다. `channel`.

### 토큰 문제

**"연결 실패" 또는 인증 오류:**

- 확인하다 `accessToken` OAuth 액세스 토큰 값입니다(일반적으로 다음으로 시작함). `oauth:` 접두사)
- 토큰을 확인하세요 `chat:read` 그리고 `chat:write` 범위
- 토큰 새로 고침을 사용하는 경우 확인하세요. `clientSecret` 그리고 `refreshToken` 설정되어 있다

### 토큰 새로 고침이 작동하지 않습니다

**새로 고침 이벤트 로그를 확인하세요.**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

"토큰 새로 고침 비활성화됨(새로 고침 토큰 없음)"이 표시되는 경우:

- 보장하다 `clientSecret` 제공된다
- 보장하다 `refreshToken` 제공된다

## 구성

**계정 구성:**

- `username` - 봇 사용자 이름
- `accessToken` - OAuth 액세스 토큰 `chat:read` 그리고 `chat:write`
- `clientId` - Twitch 클라이언트 ID(토큰 생성기 또는 앱에서)
- `channel` - 가입할 채널 (필수)
- `enabled` - 이 계정을 활성화합니다(기본값: `true`)
- `clientSecret` - 선택사항: 자동 토큰 새로고침용
- `refreshToken` - 선택사항: 자동 토큰 새로고침용
- `expiresIn` - 토큰 만료(초)
- `obtainmentTimestamp` - 토큰 획득 타임스탬프
- `allowFrom` - 사용자 ID 허용 목록
- `allowedRoles` - 역할 기반 접근 제어(`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @멘션 필요(기본값: `true`)

**제공업체 옵션:**

- `channels.twitch.enabled` - 채널 시작 활성화/비활성화
- `channels.twitch.username` - 봇 사용자 이름(단순화된 단일 계정 구성)
- `channels.twitch.accessToken` - OAuth 액세스 토큰(단순화된 단일 계정 구성)
- `channels.twitch.clientId` - Twitch 클라이언트 ID(단순화된 단일 계정 구성)
- `channels.twitch.channel` - 가입할 채널(단순한 단일 계정 구성)
- `channels.twitch.accounts.<accountName>` - 다중 계정 구성(위의 모든 계정 필드)

전체 예:

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

상담원이 전화할 수 있습니다. `twitch` 행동으로:

- `send` - 채널에 메시지 보내기

예:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## 안전 및 운영

- **토큰을 비밀번호처럼 취급하세요** - Git에 토큰을 커밋하지 마세요.
- **자동 토큰 새로 고침 사용** 장기 실행 봇의 경우
- **사용자 ID 허용 목록 사용** 액세스 제어를 위한 사용자 이름 대신
- **로그 모니터링** 토큰 새로 고침 이벤트 및 연결 상태
- **범위 토큰을 최소한으로** - 요청만 가능 `chat:read` 그리고 `chat:write`
- **막힌 경우**: 세션을 소유한 다른 프로세스가 없는지 확인한 후 게이트웨이를 다시 시작합니다.

## 제한

- **500자** 메시지당(단어 경계에서 자동 청크됨)
- Markdown은 청크 전에 제거됩니다.
- 속도 제한 없음(Twitch에 내장된 속도 제한 사용)
