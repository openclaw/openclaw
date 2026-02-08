---
summary: "타이핑 인디케이터 설정"
read_when:
  - 타이핑 표시를 설정할 때
title: "타이핑 표시"
---

# 타이핑 표시

에이전트가 응답을 준비할 때 타이핑 인디케이터를 표시합니다.

## 설정

### 기본 활성화

```json5
{
  channels: {
    telegram: {
      typingIndicator: true,
    },
    whatsapp: {
      typingIndicator: true,
    },
    discord: {
      typingIndicator: true,
    },
  },
}
```

### 전역 설정

```json5
{
  agents: {
    defaults: {
      typingIndicator: true,
    },
  },
}
```

## 동작

1. **메시지 수신**: 타이핑 시작
2. **처리 중**: 주기적 갱신
3. **응답 전송**: 타이핑 종료

### 갱신 간격

```json5
{
  agents: {
    defaults: {
      typingIndicator: {
        enabled: true,
        refreshInterval: 5000, // ms
      },
    },
  },
}
```

## 채널별 지원

| 채널     | 타이핑 표시 | 비고               |
| -------- | ----------- | ------------------ |
| Telegram | ✅          | 5초마다 갱신 필요  |
| WhatsApp | ✅          | 네이티브 지원      |
| Discord  | ✅          | 10초마다 갱신 필요 |
| Slack    | ✅          | 채널별 상이        |
| iMessage | ❌          | 지원 안 됨         |

## 문제 해결

### 타이핑 표시 안 됨

1. 채널 설정 확인
2. 채널 지원 여부 확인
3. Gateway 연결 상태 확인

### 타이핑이 너무 빨리 종료

1. 갱신 간격 설정 확인
