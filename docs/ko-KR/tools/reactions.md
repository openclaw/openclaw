---
summary: "리액션 및 이모지 기능"
read_when:
  - 리액션 기능을 사용할 때
title: "리액션"
---

# 리액션

에이전트가 메시지에 리액션(이모지)을 추가하는 기능입니다.

## 지원 채널

| 채널     | 리액션 수신 | 리액션 전송 |
| -------- | ----------- | ----------- |
| Telegram | ✅          | ✅          |
| WhatsApp | ✅          | ✅          |
| Discord  | ✅          | ✅          |
| Slack    | ✅          | ✅          |
| iMessage | ❌          | ❌          |

## 설정

### 리액션 활성화

```json5
{
  channels: {
    telegram: {
      actions: {
        reactions: true,
      },
    },
  },
}
```

### 모든 채널

```json5
{
  agents: {
    defaults: {
      actions: {
        reactions: true,
      },
    },
  },
}
```

## 리액션 사용

에이전트가 리액션을 보내는 방법:

### 현재 메시지에

```
[[react:👍]]
```

### 특정 메시지에

```
[[react:👍:message_id]]
```

## 자동 리액션

### 처리 중 표시

```json5
{
  channels: {
    telegram: {
      reactions: {
        onProcessing: "🔄",
        onComplete: null, // 완료 시 리액션 제거
      },
    },
  },
}
```

### 오류 시

```json5
{
  channels: {
    telegram: {
      reactions: {
        onError: "❌",
      },
    },
  },
}
```

## 리액션 수신

사용자가 리액션을 추가하면 에이전트에게 전달:

```json5
{
  channels: {
    telegram: {
      reactions: {
        onReceive: true,
      },
    },
  },
}
```

### 리액션 기반 동작

```json5
{
  channels: {
    telegram: {
      reactions: {
        triggers: {
          "👍": "긍정적 피드백으로 기록",
          "👎": "부정적 피드백으로 기록",
          "🔄": "이전 응답 재생성",
        },
      },
    },
  },
}
```

## 이모지 제한

### 허용 이모지

```json5
{
  channels: {
    telegram: {
      reactions: {
        allowed: ["👍", "👎", "❤️", "😊", "🔥"],
      },
    },
  },
}
```

## 채널별 차이

### Telegram

- 이모지 리액션 지원
- 프리미엄 이모지 제한적

### Discord

- 커스텀 이모지 지원
- 서버 이모지 사용 가능

### Slack

- 이모지 코드 형식 (`:thumbsup:`)

### WhatsApp

- 제한된 이모지 세트
