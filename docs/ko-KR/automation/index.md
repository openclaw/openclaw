---
summary: "크론 작업, 웹훅, 자동화 설정 가이드"
read_when:
  - 자동화 작업을 설정할 때
title: "자동화"
---

# 자동화

OpenClaw는 다양한 자동화 기능을 제공합니다.

## 크론 작업 (Cron Jobs)

정기적으로 에이전트를 호출하는 예약 작업입니다.

### 크론 작업 설정

```json5
{
  cron: {
    jobs: [
      {
        id: "daily-report",
        schedule: "0 9 * * *", // 매일 오전 9시
        prompt: "오늘의 할 일 목록을 정리해줘",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
      {
        id: "hourly-check",
        schedule: "0 * * * *", // 매시간
        prompt: "시스템 상태를 확인해줘",
        agent: "monitor",
      },
    ],
  },
}
```

### 크론 스케줄 형식

표준 cron 형식: `분 시 일 월 요일`

| 예시             | 설명                          |
| ---------------- | ----------------------------- |
| `0 9 * * *`      | 매일 오전 9시                 |
| `*/30 * * * *`   | 30분마다                      |
| `0 0 * * 0`      | 매주 일요일 자정              |
| `0 8-18 * * 1-5` | 평일 오전 8시~오후 6시 매시간 |

### 크론 작업 관리

```bash
# 크론 작업 목록
openclaw cron list

# 수동 실행
openclaw cron run <job-id>

# 크론 작업 상태
openclaw cron status
```

## 하트비트 (Heartbeat)

정기적인 에이전트 체크인입니다.

### 하트비트 vs 크론

| 특성   | 하트비트            | 크론        |
| ------ | ------------------- | ----------- |
| 목적   | 상태 확인           | 작업 실행   |
| 트리거 | 내부 타이머         | cron 스케줄 |
| 응답   | `HEARTBEAT_OK` 가능 | 항상 응답   |

### 하트비트 설정

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "1h", // 1시간마다
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    },
  },
}
```

### HEARTBEAT.md

워크스페이스에 `HEARTBEAT.md` 파일을 만들어 하트비트 동작을 정의:

```markdown
# 하트비트 체크리스트

1. 중요한 알림이 있는지 확인
2. 예약된 작업 상태 확인
3. 특별한 것이 없으면 HEARTBEAT_OK 응답
```

## 웹훅 (Webhook)

외부 서비스에서 OpenClaw를 트리거합니다.

### 웹훅 활성화

```json5
{
  webhook: {
    enabled: true,
    secret: "your_webhook_secret",
    path: "/webhook",
  },
}
```

### 웹훅 URL

```
POST http://127.0.0.1:18789/webhook
Authorization: Bearer your_webhook_secret
Content-Type: application/json

{
  "prompt": "이 알림을 처리해줘",
  "context": {
    "source": "github",
    "event": "push"
  }
}
```

### 웹훅 응답 라우팅

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "github" },
        agent: "devops",
        target: { channel: "slack", to: "C12345678" },
      },
      {
        match: { source: "monitoring" },
        agent: "monitor",
        target: { channel: "telegram", to: "123456789" },
      },
    ],
  },
}
```

## 폴링 (Poll)

외부 소스를 주기적으로 확인합니다.

### 폴링 설정

```json5
{
  poll: {
    sources: [
      {
        id: "rss-feed",
        url: "https://example.com/feed.xml",
        interval: "15m",
        prompt: "새 글이 있으면 요약해줘",
      },
    ],
  },
}
```

## Gmail 통합

Gmail Pub/Sub를 통한 이메일 자동화

### 설정 단계

1. Google Cloud 프로젝트 설정
2. Gmail API 활성화
3. Pub/Sub 토픽 생성
4. OpenClaw 설정

```json5
{
  gmail: {
    enabled: true,
    projectId: "your-project-id",
    topicName: "gmail-notifications",
    subscriptionName: "openclaw-gmail",
  },
}
```

## 훅 (Hooks)

특정 이벤트에 반응하는 커스텀 로직입니다.

### 훅 유형

| 훅           | 트리거 시점     |
| ------------ | --------------- |
| `onMessage`  | 메시지 수신 시  |
| `onResponse` | 응답 생성 후    |
| `onError`    | 오류 발생 시    |
| `onStartup`  | Gateway 시작 시 |
| `onShutdown` | Gateway 종료 시 |

### 훅 설정

```json5
{
  hooks: {
    onMessage: [
      {
        match: { channel: "telegram", isGroup: true },
        action: "log",
        config: { level: "info" },
      },
    ],
    onStartup: [
      {
        action: "notify",
        config: {
          channel: "telegram",
          to: "123456789",
          message: "Gateway가 시작되었습니다",
        },
      },
    ],
  },
}
```

## 자동화 문제 해결

### 크론이 실행되지 않음

1. 크론 작업이 활성화되어 있는지 확인:

```bash
openclaw cron list
```

2. Gateway가 계속 실행 중인지 확인

3. 로그 확인:

```bash
openclaw logs --follow --filter cron
```

### 웹훅이 응답하지 않음

1. 웹훅 엔드포인트 테스트:

```bash
curl -X POST http://127.0.0.1:18789/webhook \
  -H "Authorization: Bearer your_secret" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test"}'
```

2. secret이 올바른지 확인

3. 방화벽/네트워크 설정 확인
