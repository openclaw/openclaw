---
summary: "하트비트 설정 및 HEARTBEAT.md 작성"
read_when:
  - 하트비트를 설정할 때
title: "하트비트"
---

# 하트비트

하트비트는 에이전트가 정기적으로 체크인하는 메커니즘입니다.

## 크론 vs 하트비트

| 특성      | 크론            | 하트비트            |
| --------- | --------------- | ------------------- |
| 목적      | 특정 작업 실행  | 상태 확인           |
| 프롬프트  | 명시적으로 설정 | HEARTBEAT.md에서    |
| 응답      | 항상 전송       | HEARTBEAT_OK 가능   |
| 사용 사례 | 보고서, 알림    | 모니터링, 자율 체크 |

## 기본 설정

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "1h",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    },
  },
}
```

## 간격 설정

### 형식

```
<숫자><단위>
```

### 예시

| 값    | 의미  |
| ----- | ----- |
| `15m` | 15분  |
| `1h`  | 1시간 |
| `4h`  | 4시간 |
| `1d`  | 1일   |

### 설정 예시

```json5
{
  heartbeat: {
    every: "30m", // 30분마다
  },
}
```

## HEARTBEAT.md

워크스페이스에 `HEARTBEAT.md` 파일을 만들어 하트비트 동작을 정의합니다.

### 기본 예시

```markdown
# 하트비트 체크리스트

하트비트가 트리거되면 다음을 확인하세요:

1. 중요한 알림이 있는지 확인
2. 예약된 작업 상태 확인
3. 시스템 상태 점검

## 응답 지침

- 보고할 것이 없으면 `HEARTBEAT_OK` 응답
- 중요한 것이 있으면 사용자에게 알림
- 긴급한 것은 즉시 알림
```

### 상세 예시

```markdown
# 하트비트 지침

## 확인 항목

### 1. 일정 확인

- 오늘 일정 확인
- 다가오는 마감 확인

### 2. 시스템 모니터링

- 디스크 공간 확인
- 중요 프로세스 상태

### 3. 커뮤니케이션

- 미확인 이메일
- 미응답 메시지

## 응답 규칙

### 보고할 것이 없을 때

HEARTBEAT_OK를 반환합니다.

### 보고할 것이 있을 때

다음 형식으로 알림:

- 📌 [중요도] 내용
- 예: 📌 [높음] 디스크 공간 부족 (10% 남음)

### 긴급 상황

🚨 를 사용하여 즉시 알림
```

## HEARTBEAT_OK

### 의미

`HEARTBEAT_OK`를 응답하면:

- 메시지가 전송되지 않음
- "아무 것도 보고할 것 없음" 의미
- 조용히 완료됨

### 사용법

에이전트가 확인 후 특별한 것이 없으면:

```
HEARTBEAT_OK
```

## 에이전트별 하트비트

```json5
{
  agents: {
    list: [
      {
        id: "main",
        heartbeat: {
          every: "1h",
          target: {
            channel: "telegram",
            to: "123456789",
          },
        },
      },
      {
        id: "monitor",
        heartbeat: {
          every: "15m",
          target: {
            channel: "slack",
            to: "C12345678",
          },
        },
      },
    ],
  },
}
```

## 조건부 하트비트

### 활성 시간대만

```json5
{
  heartbeat: {
    every: "1h",
    activeHours: {
      start: 8,
      end: 22,
    },
    timezone: "Asia/Seoul",
  },
}
```

### 평일만

```json5
{
  heartbeat: {
    every: "1h",
    activeDays: [1, 2, 3, 4, 5], // 월-금
  },
}
```

## 임시 중지

### 채팅에서

```
/heartbeat pause 2h
/heartbeat resume
```

### CLI에서

```bash
openclaw heartbeat pause --duration 2h
openclaw heartbeat resume
```

## 로깅

```json5
{
  heartbeat: {
    logging: {
      all: true, // HEARTBEAT_OK도 로깅
    },
  },
}
```

## 문제 해결

### 하트비트가 실행되지 않음

1. Gateway가 계속 실행 중인지 확인
2. 하트비트가 활성화되어 있는지 확인
3. 간격 설정이 올바른지 확인

### 너무 많은 메시지

1. 간격 늘리기
2. HEARTBEAT.md에서 HEARTBEAT_OK 사용 유도
3. 활성 시간대 설정
