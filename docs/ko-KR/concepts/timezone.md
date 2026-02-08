---
summary: "시간대 설정 및 현지화"
read_when:
  - 시간대를 설정할 때
title: "시간대"
---

# 시간대

OpenClaw의 시간대 설정입니다.

## 기본 설정

```json5
{
  timezone: "Asia/Seoul",
}
```

## 시간대 영향

시간대가 영향을 미치는 기능:

- 크론 작업 실행 시간
- 하트비트 활성 시간대
- 시스템 프롬프트의 시간 변수
- 로그 타임스탬프

## 에이전트에게 시간 제공

시스템 프롬프트에서:

```markdown
현재 시간: {{datetime}}
시간대: {{timezone}}
```

에이전트가 받는 정보:

```
현재 시간: 2024-02-08 15:30:00
시간대: Asia/Seoul
```

## 사용자별 시간대

### 바인딩으로 설정

```json5
{
  bindings: [
    {
      peer: { kind: "dm", channel: "telegram", sender: "123456789" },
      timezone: "America/New_York",
    },
    {
      peer: { kind: "dm", channel: "telegram", sender: "987654321" },
      timezone: "Europe/London",
    },
  ],
}
```

## 크론 작업

크론 표현식은 설정된 시간대 기준:

```json5
{
  timezone: "Asia/Seoul",
  cron: {
    jobs: [
      {
        id: "morning",
        schedule: "0 9 * * *", // 한국 시간 오전 9시
        prompt: "좋은 아침!",
      },
    ],
  },
}
```

## 하트비트 활성 시간

```json5
{
  timezone: "Asia/Seoul",
  agents: {
    defaults: {
      heartbeat: {
        every: "1h",
        activeHours: {
          start: 8, // 오전 8시
          end: 22, // 오후 10시
        },
      },
    },
  },
}
```

## 로그 시간대

```json5
{
  logging: {
    timezone: "UTC", // 로그는 UTC로 기록
  },
}
```

## 지원 시간대

IANA 시간대 데이터베이스의 모든 시간대 지원:

| 지역      | 예시                  |
| --------- | --------------------- |
| 한국      | `Asia/Seoul`          |
| 일본      | `Asia/Tokyo`          |
| 미국 동부 | `America/New_York`    |
| 미국 서부 | `America/Los_Angeles` |
| 영국      | `Europe/London`       |
| 독일      | `Europe/Berlin`       |
| UTC       | `UTC`                 |

## 문제 해결

### 시간이 맞지 않음

1. 시스템 시간대 확인:

```bash
timedatectl
# 또는
date
```

2. OpenClaw 시간대 설정 확인

3. 크론 작업이 예상대로 실행되는지 확인
