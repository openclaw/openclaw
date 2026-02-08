---
summary: "Discord 봇 통합: 설정, DM, 서버, 슬래시 명령어"
read_when:
  - Discord 기능 작업 시
title: "Discord"
---

# Discord (Bot API)

상태: discord.js를 통한 DM + 서버에서 프로덕션 준비 완료.

## 빠른 설정 (초보자)

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 애플리케이션과 봇을 생성합니다.
2. 봇 토큰을 복사합니다.
3. 토큰을 설정합니다:
   - 환경변수: `DISCORD_BOT_TOKEN=...`
   - 또는 설정: `channels.discord.token: "..."`
4. Gateway를 시작합니다.

최소 설정:

```json5
{
  channels: {
    discord: {
      token: "your_bot_token",
      dm: {
        policy: "pairing",
      },
    },
  },
}
```

## Discord 앱 설정

### 1) 애플리케이션 생성

1. [Discord Developer Portal](https://discord.com/developers/applications)로 이동합니다.
2. "New Application"을 클릭하고 이름을 입력합니다.
3. Bot 탭으로 이동하여 "Add Bot"을 클릭합니다.

### 2) 봇 토큰 얻기

1. Bot 탭에서 "Reset Token"을 클릭합니다.
2. 토큰을 복사하고 안전하게 저장합니다.

### 3) 권한 설정

1. OAuth2 → URL Generator로 이동합니다.
2. Scopes: `bot`, `applications.commands` 선택
3. Bot Permissions:
   - Send Messages
   - Read Message History
   - Add Reactions
   - Use Slash Commands

### 4) 봇 초대

생성된 URL로 봇을 서버에 초대합니다.

## 설정 예시

```json5
{
  channels: {
    discord: {
      token: "your_bot_token",
      dm: {
        policy: "pairing",
        allowFrom: ["user_id_1", "user_id_2"],
      },
      guilds: {
        guild_id: {
          requireMention: true,
        },
      },
    },
  },
}
```

## DM 정책

| 정책        | 설명                                            |
| ----------- | ----------------------------------------------- |
| `pairing`   | 알 수 없는 발신자에게 페어링 코드 전송 (기본값) |
| `allowlist` | `allowFrom`에 있는 사용자만 허용                |
| `open`      | 모든 DM 허용 (`allowFrom`에 `"*"` 필요)         |
| `disabled`  | DM 비활성화                                     |

## 서버(길드) 설정

```json5
{
  channels: {
    discord: {
      guilds: {
        "*": { requireMention: true }, // 모든 서버 기본값
        "123456789": {
          requireMention: false, // 특정 서버에서 항상 응답
          allowFrom: ["user_id"], // 특정 사용자만 허용
        },
      },
    },
  },
}
```

## 슬래시 명령어

OpenClaw는 Discord 슬래시 명령어를 자동 등록합니다:

- `/status` - 세션 상태
- `/reset` - 세션 초기화
- `/model` - 모델 정보

## 리액션

리액션 기능 활성화:

```json5
{
  channels: {
    discord: {
      actions: {
        reactions: true,
      },
    },
  },
}
```

## 문제 해결

### 봇이 응답하지 않음

1. 봇 토큰이 올바른지 확인
2. 봇이 서버에 있는지 확인
3. 필요한 권한이 있는지 확인
4. `openclaw logs --follow`로 로그 확인

### 슬래시 명령어가 표시되지 않음

- 슬래시 명령어는 등록에 최대 1시간이 걸릴 수 있습니다
- 개발 중에는 특정 길드에만 등록하여 즉시 사용 가능
