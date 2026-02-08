---
summary: "Slack 봇 통합: 설정, DM, 채널, 스레드"
read_when:
  - Slack 기능 작업 시
title: "Slack"
---

# Slack (Bolt)

상태: Bolt 프레임워크를 통한 DM + 채널에서 프로덕션 준비 완료.

## 빠른 설정

1. [Slack API](https://api.slack.com/apps)에서 앱을 생성합니다.
2. Bot Token과 App Token을 얻습니다.
3. 토큰을 설정합니다:
   - 환경변수: `SLACK_BOT_TOKEN=...` 및 `SLACK_APP_TOKEN=...`
   - 또는 설정 파일 사용
4. Gateway를 시작합니다.

최소 설정:

```json5
{
  channels: {
    slack: {
      botToken: "xoxb-...",
      appToken: "xapp-...",
    },
  },
}
```

## Slack 앱 설정

### 1) 앱 생성

1. [Slack API](https://api.slack.com/apps)로 이동합니다.
2. "Create New App" → "From scratch"를 선택합니다.
3. 앱 이름과 워크스페이스를 선택합니다.

### 2) Socket Mode 활성화

1. Settings → Socket Mode로 이동합니다.
2. "Enable Socket Mode"를 켭니다.
3. App-Level Token을 생성합니다 (Scope: `connections:write`).
4. App Token (`xapp-`)을 저장합니다.

### 3) Bot Token 얻기

1. OAuth & Permissions로 이동합니다.
2. Bot Token Scopes 추가:
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `users:read`
3. "Install to Workspace"를 클릭합니다.
4. Bot Token (`xoxb-`)을 복사합니다.

### 4) 이벤트 구독

1. Event Subscriptions로 이동합니다.
2. "Enable Events"를 켭니다.
3. Subscribe to bot events:
   - `message.im`
   - `message.channels` (선택사항)

## 설정 예시

```json5
{
  channels: {
    slack: {
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        policy: "pairing",
        allowFrom: ["U12345678"],
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
| `open`      | 모든 DM 허용                                    |
| `disabled`  | DM 비활성화                                     |

## 채널 설정

```json5
{
  channels: {
    slack: {
      channels: {
        C12345678: {
          requireMention: true,
        },
      },
    },
  },
}
```

## 스레드 지원

Slack 스레드는 자동으로 처리됩니다:

- 스레드 메시지는 같은 스레드에 응답합니다
- 스레드별로 컨텍스트가 유지됩니다

## 문제 해결

### 봇이 연결되지 않음

1. Socket Mode가 활성화되어 있는지 확인
2. App Token이 올바른지 확인
3. 필요한 권한이 모두 있는지 확인

### 메시지를 받지 못함

1. Event Subscriptions가 활성화되어 있는지 확인
2. 봇이 채널에 초대되어 있는지 확인
3. `openclaw logs --follow`로 로그 확인
