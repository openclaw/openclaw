---
summary: "응답 스트리밍, 타이핑 인디케이터, 드래프트"
read_when:
  - 실시간 응답을 설정할 때
title: "스트리밍"
---

# 스트리밍

OpenClaw는 실시간 응답 스트리밍을 지원합니다.

## 스트리밍이란?

스트리밍은 에이전트 응답을 실시간으로 전송하는 기능입니다:

- 사용자가 응답을 기다리는 시간 감소
- 긴 응답도 점진적으로 표시
- 대화가 더 자연스럽게 느껴짐

## 채널별 스트리밍 지원

| 채널     | 스트리밍 | 방식            |
| -------- | -------- | --------------- |
| Telegram | ✅ DM만  | 메시지 편집     |
| WebChat  | ✅       | 실시간 업데이트 |
| Discord  | ✅       | 메시지 편집     |
| WhatsApp | ❌       | 미지원          |
| Slack    | ✅       | 메시지 업데이트 |

## 스트리밍 모드

### Partial (기본값)

응답을 청크 단위로 업데이트:

```json5
{
  channels: {
    telegram: {
      streamMode: "partial",
    },
  },
}
```

### Full

전체 응답이 완료된 후 전송:

```json5
{
  channels: {
    telegram: {
      streamMode: "full",
    },
  },
}
```

### Off

스트리밍 비활성화:

```json5
{
  channels: {
    telegram: {
      streamMode: "off",
    },
  },
}
```

## 타이핑 인디케이터

에이전트가 응답을 생성하는 동안 타이핑 표시:

```json5
{
  channels: {
    telegram: {
      typingIndicator: true,
    },
  },
}
```

### 타이핑 지원 채널

| 채널     | 타이핑 표시 |
| -------- | ----------- |
| Telegram | ✅          |
| WhatsApp | ✅          |
| Discord  | ✅          |
| Slack    | ❌          |

## 드래프트 스트리밍 (Telegram)

Telegram DM에서 부분 응답을 실시간 전송:

### 요구사항

1. 봇에서 스레드 모드 활성화 (@BotFather)
2. 프라이빗 채팅 스레드 사용
3. `streamMode`가 `"off"`가 아닌 상태

### 작동 방식

1. 에이전트가 응답 생성 시작
2. 부분 응답이 실시간으로 전송
3. 각 청크마다 메시지 업데이트
4. 최종 응답으로 완료

## 청크 설정

### 업데이트 간격

```json5
{
  agents: {
    defaults: {
      streaming: {
        updateInterval: 500, // ms
      },
    },
  },
}
```

### 최소 청크 크기

```json5
{
  agents: {
    defaults: {
      streaming: {
        minChunkSize: 50, // 문자
      },
    },
  },
}
```

## WebChat 스트리밍

브라우저에서 실시간 응답:

```json5
{
  web: {
    streaming: {
      enabled: true,
      showCursor: true, // 타이핑 커서 표시
    },
  },
}
```

## Control UI 스트리밍

Control UI에서는 기본적으로 스트리밍이 활성화:

- 실시간 응답 표시
- 타이핑 애니메이션
- 진행 상태 표시

## 성능 고려사항

### 네트워크 최적화

스트리밍은 더 많은 네트워크 요청을 생성합니다:

```json5
{
  agents: {
    defaults: {
      streaming: {
        batchUpdates: true, // 업데이트 배치 처리
        maxUpdatesPerSecond: 2,
      },
    },
  },
}
```

### API 비용

스트리밍 자체는 추가 API 비용이 없습니다.
토큰 사용량은 동일합니다.

## 문제 해결

### 스트리밍이 작동하지 않음

1. 채널이 스트리밍을 지원하는지 확인
2. `streamMode`가 "off"가 아닌지 확인
3. 네트워크 연결 확인

### 메시지가 깜빡임

업데이트 간격을 늘려보세요:

```json5
{
  agents: {
    defaults: {
      streaming: {
        updateInterval: 1000,
      },
    },
  },
}
```

### Rate Limit 오류

Telegram 등 일부 채널은 메시지 업데이트에 Rate Limit이 있습니다:

```json5
{
  channels: {
    telegram: {
      streaming: {
        rateLimit: {
          maxUpdates: 20,
          window: 60, // 초
        },
      },
    },
  },
}
```
