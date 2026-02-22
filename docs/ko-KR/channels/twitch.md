---
summary: "Twitch 챗봇 구성 및 설정"
read_when:
  - OpenClaw에 대한 Twitch 채팅 통합 설정
title: "Twitch"
---

# Twitch (플러그인)

Twitch 채팅은 IRC 연결을 통해 지원됩니다. OpenClaw는 Twitch 사용자(봇 계정)로 연결하여 채널에서 메시지를 수신 및 전송합니다.

## 플러그인 필요

Twitch는 플러그인으로 제공되며 코어 설치와 함께 제공되지 않습니다.

CLI(npm 레지스트리)로 설치:

```bash
openclaw plugins install @openclaw/twitch
```

로컬 체크아웃(git 리포지토리에서 실행 중일 경우):

```bash
openclaw plugins install ./extensions/twitch
```

자세한 내용: [플러그인](/ko-KR/tools/plugin)

## 빠른 설정(초보자)

1. 봇을 위한 전용 Twitch 계정을 생성하거나 기존 계정을 사용합니다.
2. 자격 증명 생성: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** 선택
   - `chat:read` 및 `chat:write` 범위가 선택되어 있는지 확인
   - **Client ID** 및 **Access Token** 복사
3. Twitch 사용자 ID 찾기: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 토큰 설정:
   - 환경 변수: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (기본 계정만 해당)
   - 또는 구성: `channels.twitch.accessToken`
   - 둘 다 설정되어 있는 경우, 구성 값이 우선적으로 사용됩니다(환경 변수는 기본 계정에 대한 백업 용도만).
5. 게이트웨이 시작.

**⚠️ 중요:** 무단 사용자가 봇을 트리거하지 못하도록 `allowFrom` 또는 `allowedRoles`로 액세스 제어를 추가하세요. `requireMention`의 기본값은 `true`입니다.

최소 구성:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 봇의 Twitch 계정
      accessToken: "oauth:abc123...", // OAuth 접근 토큰(또는 OPENCLAW_TWITCH_ACCESS_TOKEN 환경 변수를 사용)
      clientId: "xyz789...", // Token Generator로부터 생성한 클라이언트 ID
      channel: "vevisk", // 참여할 Twitch 채널의 채팅(필수)
      allowFrom: ["123456789"], // (권장) 본인의 Twitch 사용자 ID만 허용 - https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/에서 얻을 수 있음
    },
  },
}
```

## 그것이 무엇인가

- 게이트웨이에 의해 소유된 Twitch 채널.
- 결정론적 라우팅: 답변은 항상 Twitch로 돌아갑니다.
- 각 계정은 고립된 세션 키 `agent:<agentId>:twitch:<accountName>`에 매핑됩니다.
- `username`은 봇의 계정(인증하는 주체), `channel`은 참여할 채팅방입니다.

## 설정(상세)

### 자격 증명 생성

[Twitch Token Generator](https://twitchtokengenerator.com/) 사용:

- **Bot Token** 선택
- `chat:read` 및 `chat:write` 범위가 선택되어 있는지 확인
- **Client ID** 및 **Access Token** 복사

수동 앱 등록이 필요하지 않습니다. 토큰은 몇 시간 후 만료됩니다.

### 봇 구성

**환경 변수(기본 계정만 해당):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**또는 구성:**

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

환경 변수와 구성 모두 설정된 경우, 구성 값이 우선합니다.

### 액세스 제어(권장됨)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (권장) 본인의 Twitch 사용자 ID만 허용
    },
  },
}
```

`allowFrom`을 강력한 허용 목록으로 사용하는 것이 좋습니다. 역할 기반 액세스를 원한다면 `allowedRoles`을 대신 사용하십시오.

**사용 가능한 역할:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**왜 사용자 ID를 사용하나요?** 사용자 이름은 변경될 수 있어 사칭을 허용할 수 있습니다. 사용자 ID는 영구적입니다.

본인의 Twitch 사용자 ID 찾기: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (본인의 Twitch 사용자 이름을 ID로 변환)

## 토큰 갱신(선택적)

[Twitch Token Generator](https://twitchtokengenerator.com/)에서 생성된 토큰은 자동으로 갱신될 수 없습니다 - 만료 시 갱신하십시오.

자동 토큰 갱신을 위해, [Twitch Developer Console](https://dev.twitch.tv/console)에서 자체 Twitch 애플리케이션을 생성하고 구성에 추가하십시오:

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

봇은 만료 전 자동으로 토큰을 갱신하고 갱신 이벤트를 기록합니다.

## 다중 계정 지원

각 계정별 토큰으로 `channels.twitch.accounts`를 사용하세요. 공유 패턴에 대한 자세한 내용은 [`gateway/configuration`](/ko-KR/gateway/configuration)를 참조하세요.

예시 (두 채널에 하나의 봇 계정):

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

**참고:** 각 계정은 자체 토큰이 필요합니다(채널당 하나의 토큰).

## Access control

### Role-based restrictions

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

### Allowlist by User ID (most secure)

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

### Role-based access (alternative)

`allowFrom`는 강력한 허용 목록입니다. 설정된 경우, 이러한 사용자 ID만 허용됩니다.
역할 기반 접근을 원한다면, `allowFrom`을 설정 해제하고 `allowedRoles`를 대신 설정하십시오:

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

### Disable @mention requirement

기본적으로 `requireMention`은 `true`입니다. 모든 메시지에 응답하려면 다음과 같이 설정하십시오:

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

먼저, 진단 명령어를 실행하십시오:

```bash
openclaw doctor
openclaw channels status --probe
```

### 봇이 메시지에 응답하지 않음

**액세스 제어 확인:** 본인의 사용자 ID가 `allowFrom`에 있는지 확인하거나,
`allowFrom`을 임시로 제거하고 `allowedRoles: ["all"]`을 설정하여 테스트하십시오.

**봇이 채널에 있는지 확인:** 봇은 `channel`에 지정된 채널에 참여해야 합니다.

### 토큰 문제

**"연결 실패" 또는 인증 오류:**

- `accessToken`이 OAuth 접근 토큰 값인지 확인(일반적으로 `oauth:` 접두사로 시작)
- 토큰이 `chat:read` 및 `chat:write` 범위를 가지고 있는지 확인
- 토큰 갱신을 사용하는 경우, `clientSecret` 및 `refreshToken`이 설정되어 있는지 확인

### 토큰 갱신이 작동하지 않음

**갱신 이벤트에 대한 로그 확인:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

"토큰 갱신 비활성화(갱신 토큰 없음)" 메시지가 표시되면:

- `clientSecret`이 제공되고 있는지 확인
- `refreshToken`이 제공되고 있는지 확인

## 구성

**계정 구성:**

- `username` - 봇 사용자 이름
- `accessToken` - `chat:read` 및 `chat:write` 권한이 있는 OAuth 접근 토큰
- `clientId` - Twitch 클라이언트 ID (Token Generator 또는 애플리케이션에서 제공)
- `channel` - 참여할 채널 (필수)
- `enabled` - 이 계정 활성화 여부 (기본값: `true`)
- `clientSecret` - 선택 사항: 자동 토큰 갱신용
- `refreshToken` - 선택 사항: 자동 토큰 갱신용
- `expiresIn` - 토큰 만료 시간(초 단위)
- `obtainmentTimestamp` - 토큰 획득 타임스탬프
- `allowFrom` - 사용자 ID 허용 목록
- `allowedRoles` - 역할 기반 액세스 제어(`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @언급 필요 여부 (기본값: `true`)

**프로바이더 옵션:**

- `channels.twitch.enabled` - 채널 시작 여부
- `channels.twitch.username` - 봇 사용자 이름(단일 계정 구성 간소화)
- `channels.twitch.accessToken` - OAuth 접근 토큰(단일 계정 구성 간소화)
- `channels.twitch.clientId` - Twitch 클라이언트 ID(단일 계정 구성 간소화)
- `channels.twitch.channel` - 참여할 채널 (단일 계정 구성 간소화)
- `channels.twitch.accounts.<accountName>` - 다중 계정 구성(위의 모든 계정 필드)

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

에이전트는 `twitch` 액션을 호출할 수 있습니다:

- `send` - 채널에 메시지 전송

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

## 안전 및 운영

- **토큰을 비밀번호처럼 취급** - 절대 토큰을 git에 커밋하지 않기
- **자동 토큰 갱신 사용** - 장기 실행 봇에 필수
- **사용자 ID 허용 목록 사용** - 액세스 제어에 사용자 이름 대신 사용
- **로그 모니터링** - 토큰 갱신 이벤트 및 연결 상태 확인
- **토큰 최소 범위 설정** - `chat:read` 및 `chat:write`만 요청
- **문제가 발생하면**: 세션을 소유한 다른 프로세스가 없음을 확인한 후 게이트웨이를 재시작

## 제한

- **500자** 이상 메시지당(단어 경계에서 자동 분할)
- 마크다운은 분할 전에 제거
- 속도 제한 없음(Twitch의 내장 속도 제한 사용)