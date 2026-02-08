---
summary: "크론 작업 상세 설정 및 예시"
read_when:
  - 크론 작업을 설정할 때
title: "크론 작업"
---

# 크론 작업

정기적으로 에이전트를 호출하는 예약 작업입니다.

## 기본 설정

```json5
{
  cron: {
    jobs: [
      {
        id: "morning-briefing",
        schedule: "0 9 * * *",
        prompt: "오늘의 뉴스와 날씨를 알려줘",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

## 스케줄 형식

### cron 표현식

```
분 시 일 월 요일
*  *  *  *  *
```

### 예시

| 표현식           | 설명                          |
| ---------------- | ----------------------------- |
| `0 9 * * *`      | 매일 오전 9시                 |
| `*/30 * * * *`   | 30분마다                      |
| `0 */2 * * *`    | 2시간마다                     |
| `0 0 * * 0`      | 매주 일요일 자정              |
| `0 8-18 * * 1-5` | 평일 오전 8시~오후 6시 매시간 |
| `0 0 1 * *`      | 매월 1일 자정                 |
| `0 12 * * 1,3,5` | 월/수/금 정오                 |

### 특수 문자

| 문자  | 의미      |
| ----- | --------- |
| `*`   | 모든 값   |
| `*/n` | n 간격    |
| `n-m` | 범위      |
| `n,m` | 특정 값들 |

## 상세 설정

### 기본 옵션

```json5
{
  cron: {
    jobs: [
      {
        id: "job-id",
        enabled: true,
        schedule: "0 9 * * *",
        prompt: "작업 프롬프트",
        agent: "main",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

### 옵션 설명

| 옵션       | 타입    | 필수 | 설명                       |
| ---------- | ------- | ---- | -------------------------- |
| `id`       | string  | ✅   | 고유 식별자                |
| `enabled`  | boolean | -    | 활성화 여부 (기본: true)   |
| `schedule` | string  | ✅   | cron 표현식                |
| `prompt`   | string  | ✅   | 에이전트에게 보낼 프롬프트 |
| `agent`    | string  | -    | 에이전트 ID (기본: main)   |
| `target`   | object  | -    | 응답 전송 대상             |

## 타겟 설정

### 채널로 전송

```json5
{
  target: {
    channel: "telegram",
    to: "123456789",
  },
}
```

### 그룹으로 전송

```json5
{
  target: {
    channel: "discord",
    to: "guild_id/channel_id",
  },
}
```

### 타겟 없음 (로그만)

```json5
{
  // target 생략 시 실행 결과만 로그에 기록
}
```

## 실용적인 예시

### 일일 브리핑

```json5
{
  id: "daily-briefing",
  schedule: "0 8 * * *",
  prompt: `
    오늘의 브리핑을 준비해줘:
    1. 오늘 날씨
    2. 주요 일정
    3. 미완료 작업
  `,
  target: {
    channel: "telegram",
    to: "123456789",
  },
}
```

### 시스템 모니터링

```json5
{
  id: "system-check",
  schedule: "0 */4 * * *",
  prompt: "시스템 상태를 확인하고 이상이 있으면 알려줘",
  agent: "monitor",
  target: {
    channel: "slack",
    to: "C12345678",
  },
}
```

### 백업 알림

```json5
{
  id: "backup-reminder",
  schedule: "0 18 * * 5",
  prompt: "주간 백업을 확인하고 상태를 보고해줘",
  target: {
    channel: "telegram",
    to: "123456789",
  },
}
```

### 리마인더

```json5
{
  id: "standup-reminder",
  schedule: "0 9 * * 1-5",
  prompt: "스탠드업 미팅 시간입니다. 오늘의 계획을 공유해주세요.",
  target: {
    channel: "discord",
    to: "team_channel_id",
  },
}
```

## 크론 관리

### CLI 명령어

```bash
# 크론 작업 목록
openclaw cron list

# 작업 상태
openclaw cron status

# 수동 실행
openclaw cron run <job-id>

# 다음 실행 시간 확인
openclaw cron next <job-id>
```

### 작업 활성화/비활성화

```bash
openclaw cron disable <job-id>
openclaw cron enable <job-id>
```

## 조건부 실행

### 조건 설정

```json5
{
  id: "conditional-job",
  schedule: "0 9 * * *",
  prompt: "조건부 작업",
  condition: {
    type: "file-exists",
    path: "~/flag.txt",
  },
}
```

### 조건 유형

| 유형              | 설명                  |
| ----------------- | --------------------- |
| `file-exists`     | 파일 존재 시 실행     |
| `file-not-exists` | 파일 없을 시 실행     |
| `env-set`         | 환경변수 설정 시 실행 |

## 오류 처리

### 실패 시 재시도

```json5
{
  id: "retry-job",
  schedule: "0 9 * * *",
  prompt: "실패할 수 있는 작업",
  retry: {
    maxAttempts: 3,
    delay: 60, // 초
  },
}
```

### 실패 알림

```json5
{
  id: "important-job",
  schedule: "0 9 * * *",
  prompt: "중요한 작업",
  onFailure: {
    notify: {
      channel: "telegram",
      to: "admin_id",
      message: "크론 작업 실패: {{error}}",
    },
  },
}
```

## 실행 기록

### 기록 조회

```bash
openclaw cron history <job-id>
openclaw cron history --last 10
```

### 기록 저장

```json5
{
  cron: {
    history: {
      enabled: true,
      retention: 30, // 일
    },
  },
}
```

## 문제 해결

### 크론이 실행되지 않음

1. Gateway가 실행 중인지 확인
2. 작업이 활성화되어 있는지 확인
3. 스케줄 표현식이 올바른지 확인

### 중복 실행

- `singleInstance: true`로 중복 방지:

```json5
{
  id: "single-job",
  schedule: "*/5 * * * *",
  singleInstance: true,
}
```
