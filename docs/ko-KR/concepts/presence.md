---
summary: "프레즌스 및 온라인 상태 표시"
read_when:
  - 프레즌스를 설정할 때
title: "프레즌스"
---

# 프레즌스

에이전트의 온라인 상태 표시 가이드입니다.

## 기능

- 채널에서 온라인 상태 표시
- 입력 중 표시
- 가용성 표시

## 온라인 상태

### Telegram

```json5
{
  channels: {
    telegram: {
      presence: {
        sendOnline: true,
      },
    },
  },
}
```

### Discord

```json5
{
  channels: {
    discord: {
      presence: {
        status: "online", // online | idle | dnd | invisible
        activity: {
          type: "watching", // playing | watching | listening
          name: "for messages",
        },
      },
    },
  },
}
```

### Slack

```json5
{
  channels: {
    slack: {
      presence: {
        active: true,
        statusText: "Ready to help",
        statusEmoji: ":robot_face:",
      },
    },
  },
}
```

## 입력 중 표시

### 활성화

```json5
{
  channels: {
    telegram: {
      typingIndicator: true,
    },
    whatsapp: {
      typingIndicator: true,
    },
  },
}
```

### 동작

1. 메시지 수신 시 "입력 중" 표시
2. 응답 생성 중 유지
3. 응답 전송 시 종료

## 가용성 스케줄

### 활성 시간

```json5
{
  presence: {
    schedule: {
      active: {
        start: "09:00",
        end: "22:00",
      },
      timezone: "Asia/Seoul",
    },
  },
}
```

### 비활성 시 메시지

```json5
{
  presence: {
    offlineMessage: "현재 오프라인입니다. 나중에 다시 연락해주세요.",
  },
}
```

## 상태 변경

### 채팅 명령어

```
/status busy
/status away
/status online
```

### 설정

```json5
{
  presence: {
    default: "online",
    onProcessing: "busy",
  },
}
```

## 채널별 지원

| 채널     | 온라인 상태 | 입력 중 | 커스텀 상태 |
| -------- | ----------- | ------- | ----------- |
| Telegram | ✅          | ✅      | ❌          |
| WhatsApp | ✅          | ✅      | ❌          |
| Discord  | ✅          | ✅      | ✅          |
| Slack    | ✅          | ✅      | ✅          |

## 문제 해결

### 입력 중 표시 안 됨

1. 채널 설정 확인
2. 채널별 지원 여부 확인

### 상태 업데이트 안 됨

1. 권한 확인
2. API 연결 확인
